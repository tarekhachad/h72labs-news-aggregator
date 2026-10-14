import { describe, it, expect } from "vitest";
import {
  PRICING,
  REQUEST_OVERHEAD_TOKENS,
  costFor,
  formatCallLine,
  promptTokens,
  rateCardFor,
  summarizeUsage,
  type CallTokens,
  type ModelPricing,
  type RecordedCall,
  type TrackedModel,
} from "@/lib/usage";
import { buildUsageRunRecord, settleCeilingFor, toJsonlLine, type UsageRunContext } from "@/lib/usageRecord";
import { buildCostReport, parseUsageRunLines, renderCostMarkdown } from "@/lib/costReport";
import { settleAmount } from "@/lib/spend";

// QA (review round 2, Haiku 5.5 switch): the rateCardFor guard directly, and
// the record/report path fed with mixed Haiku 5.5 short/long and Haiku 4.5
// rows. Rates are re-typed from the published card, never read off PRICING.

const AT = new Date("2026-10-13T12:00:00Z");
const tk = (p: Partial<CallTokens>): CallTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...p,
});

function bill(t: CallTokens, inRate: number, outRate: number): number {
  return (
    (t.inputTokens * inRate + t.cacheReadTokens * inRate * 0.1 + t.cacheWriteTokens * inRate * 1.25 + t.outputTokens * outRate) /
    1_000_000
  );
}
const h55 = (t: CallTokens) => (promptTokens(t) > 100_000 ? bill(t, 0.5, 2.5) : bill(t, 0.1, 0.5));
const h45 = (t: CallTokens) => bill(t, 1, 5);

const base = PRICING["claude-haiku-5-5"];
const withLong = (longContext: unknown): Record<TrackedModel, ModelPricing> =>
  ({ ...PRICING, "claude-haiku-5-5": { ...base, longContext } }) as Record<TrackedModel, ModelPricing>;
const withThreshold = (aboveTokens: unknown) => withLong({ aboveTokens, rate: base.longContext?.rate });

describe("rateCardFor: a threshold that can't prove a call short never picks the cheap card", () => {
  const malformed: [string, unknown][] = [
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["a numeric string", "100000"],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["a bigint", BigInt(100_000)],
    ["an object with valueOf", { valueOf: () => 100_000 }],
    ["a Number wrapper", Object(100_000)],
  ];
  const prompts = [tk({}), tk({ inputTokens: 1 }), tk({ inputTokens: 100_000 }), tk({ inputTokens: 100_001 }), tk({ cacheReadTokens: 5_000_000 })];

  it.each(malformed)("aboveTokens %s: every prompt size is longContext", (_name, value) => {
    for (const t of prompts) expect(rateCardFor("claude-haiku-5-5", t, withThreshold(value))).toBe("longContext");
  });

  it("aboveTokens key missing entirely: longContext", () => {
    const table = withLong({ rate: base.longContext?.rate });
    expect(rateCardFor("claude-haiku-5-5", tk({ inputTokens: 5 }), table)).toBe("longContext");
  });

  it.each([
    ["null", null],
    ["a number", 5],
    ["a string", "long"],
    ["a function", () => 0],
  ])("longContext itself %s: longContext (or unpriced downstream), never a short price", (_name, value) => {
    const card = rateCardFor("claude-haiku-5-5", tk({ inputTokens: 5 }), withLong(value));
    // A function is an object-like value: typeof "function" is not "object",
    // so the guard sends it long, and costOnCard then finds no usable rate.
    expect(card).toBe("longContext");
    const s = summarizeUsage([{ stage: "triage", model: "claude-haiku-5-5", tokens: tk({ inputTokens: 5, outputTokens: 1 }) }], AT, withLong(value));
    expect(s.unpricedModels).toEqual(["claude-haiku-5-5"]);
  });

  it("a finite valid threshold still splits on prompt tokens, cache included, output excluded", () => {
    for (const [threshold, at, over] of [
      [100_000, 100_000, 100_001],
      [0, 0, 1],
      [1, 1, 2],
      [50.5, 50, 51],
    ] as const) {
      const table = withThreshold(threshold);
      expect(rateCardFor("claude-haiku-5-5", tk({ inputTokens: at, outputTokens: 10_000_000 }), table)).toBe("standard");
      expect(rateCardFor("claude-haiku-5-5", tk({ inputTokens: over }), table)).toBe("longContext");
      expect(rateCardFor("claude-haiku-5-5", tk({ cacheReadTokens: over }), table)).toBe("longContext");
      expect(rateCardFor("claude-haiku-5-5", tk({ cacheWriteTokens: over }), table)).toBe("longContext");
    }
  });

  it("a negative finite threshold sends every call long (dearer, never cheaper)", () => {
    expect(rateCardFor("claude-haiku-5-5", tk({}), withThreshold(-1))).toBe("longContext");
  });

  it("the live table: Haiku 4.5 and Sonnet 5 are always standard, Haiku 5.5 splits at 100,000", () => {
    for (const m of ["claude-haiku-4-5", "claude-sonnet-5"] as const) {
      expect(rateCardFor(m, tk({ inputTokens: 900_000 }))).toBe("standard");
    }
    expect(rateCardFor("claude-haiku-5-5", tk({ inputTokens: 100_000 }))).toBe("standard");
    expect(rateCardFor("claude-haiku-5-5", tk({ inputTokens: 99_999, cacheReadTokens: 2 }))).toBe("longContext");
  });

  it("a model missing from the table: standard here, and costFor reports it unpriceable rather than pricing it", () => {
    const table = { ...PRICING } as Partial<Record<TrackedModel, ModelPricing>>;
    delete table["claude-haiku-5-5"];
    const t = table as Record<TrackedModel, ModelPricing>;
    expect(rateCardFor("claude-haiku-5-5", tk({ inputTokens: 200_000 }), t)).toBe("standard");
    expect(() => costFor("claude-haiku-5-5", tk({ inputTokens: 200_000 }), AT, t)).toThrow(/no pricing entry/);
  });

  it.each(malformed)("aboveTokens %s: costFor, formatCallLine and a usage-less ceiling all price at least the real long bill", (_n, value) => {
    const table = withThreshold(value);
    const short = tk({ inputTokens: 1_000, outputTokens: 100 });
    // Every malformed threshold puts a short call on the long card: 5x, never less.
    expect(costFor("claude-haiku-5-5", short, AT, table).billedUsd).toBeCloseTo(bill(short, 0.5, 2.5), 15);
    expect(formatCallLine({ stage: "triage", model: "claude-haiku-5-5", tokens: short }, AT, table)).toContain(
      `$${bill(short, 0.5, 2.5).toFixed(6)}`
    );
    const s = summarizeUsage(
      [{ stage: "writeCard", model: "claude-haiku-5-5", tokens: null, bound: { requestBytes: 200_000, maxOutputTokens: 3_072, attempts: 3 } }],
      AT,
      table
    );
    expect(s.unmeasuredBoundUsd as number).toBeGreaterThanOrEqual(3 * bill(tk({ inputTokens: 200_000 + REQUEST_OVERHEAD_TOKENS, outputTokens: 3_072 }), 0.5, 2.5) - 1e-15);
  });
});

// ---- the record and the cost report ----

const CONTEXT: UsageRunContext = {
  userId: "user-qa",
  route: "digest",
  digestId: "d",
  cardId: null,
  outcome: "complete",
  label: "qa",
  runShape: "firstOfDay",
  topicCount: 1,
  sourceCount: 1,
  articleCount: 10,
  clusterCount: 5,
  clustersAfterDedup: 5,
  notableCount: 3,
  cardsDroppedByCap: 0,
  cardsWritten: 3,
  cardsFailed: 0,
  cardFailures: [],
  triageFailedClosed: 0,
  rankApplied: true,
  expectedCalls: {},
};

const SHORT = tk({ inputTokens: 99_000, cacheReadTokens: 1_000, outputTokens: 2_000 }); // exactly 100,000: short
const LONG = tk({ inputTokens: 99_000, cacheReadTokens: 1_001, outputTokens: 2_000 }); // 100,001: long
const OLD = tk({ inputTokens: 150_000, outputTokens: 2_000 }); // Haiku 4.5 at any size: one card

function mixedCalls(): RecordedCall[] {
  return [
    { stage: "triage", model: "claude-haiku-5-5", tokens: SHORT },
    { stage: "triage", model: "claude-haiku-5-5", tokens: LONG },
    { stage: "triage", model: "claude-haiku-4-5", tokens: OLD },
    { stage: "writeCard", model: "claude-haiku-5-5", tokens: SHORT },
    { stage: "writeCard", model: "claude-haiku-5-5", tokens: SHORT },
    { stage: "writeCard", model: "claude-haiku-4-5", tokens: SHORT },
    { stage: "writeCard", model: "claude-haiku-5-5", tokens: LONG },
  ];
}
const realTotal = () =>
  mixedCalls().reduce((sum, c) => sum + (c.model === "claude-haiku-5-5" ? h55(c.tokens as CallTokens) : h45(c.tokens as CallTokens)), 0);

describe("usageRecord + costReport with mixed Haiku 5.5 short/long and Haiku 4.5 rows", () => {
  it("each (stage, model) row carries its own per-call-carded figure, and the rows sum to the run total", () => {
    const s = summarizeUsage(mixedCalls(), AT);
    const record = buildUsageRunRecord(s, CONTEXT, AT, "run-1");
    expect(record.isFloor).toBe(false);
    expect(record.stages.map((g) => `${g.stage}/${g.model}/${g.calls}`).sort()).toEqual([
      "triage/claude-haiku-4-5/1",
      "triage/claude-haiku-5-5/2",
      "writeCard/claude-haiku-4-5/1",
      "writeCard/claude-haiku-5-5/3",
    ]);
    const row = (stage: string, model: string) => record.stages.find((g) => g.stage === stage && g.model === model)!;
    expect(row("triage", "claude-haiku-5-5").billedUsd).toBeCloseTo(h55(SHORT) + h55(LONG), 15);
    expect(row("writeCard", "claude-haiku-5-5").billedUsd).toBeCloseTo(2 * h55(SHORT) + h55(LONG), 15);
    expect(row("triage", "claude-haiku-4-5").billedUsd).toBeCloseTo(h45(OLD), 15);
    expect(row("writeCard", "claude-haiku-4-5").billedUsd).toBeCloseTo(h45(SHORT), 15);
    // The flattened row's tokens are the group sum. Re-pricing the row's
    // summed tokens would cross the threshold and over-price: the record
    // must carry the per-call figure, not something re-derivable from tokens.
    const triageRow = row("triage", "claude-haiku-5-5");
    expect(promptTokens(triageRow.tokens)).toBe(200_001);
    expect(costFor("claude-haiku-5-5", triageRow.tokens, AT).billedUsd).toBeGreaterThan(triageRow.billedUsd);
    const sum = record.stages.reduce((a, g) => a + g.billedUsd, 0);
    expect(record.totalBilledUsd).toBeCloseTo(sum, 15);
    expect(record.totalBilledUsd).toBeCloseTo(realTotal(), 15);
    expect(record.totalListUsd).toBeCloseTo(record.totalBilledUsd, 15);
  });

  it("settles a measured run at exactly its real bill", () => {
    const s = summarizeUsage(mixedCalls(), AT);
    const record = buildUsageRunRecord(s, CONTEXT, AT, "run-1");
    expect(settleCeilingFor(s, {})).toBeNull();
    expect(settleAmount(0.7, record, null)).toBeCloseTo(realTotal(), 15);
  });

  it("a usage-less Haiku 5.5 call straddling the threshold: the ceiling covers its worst bill on the long card", () => {
    const bytes = 100_000 - REQUEST_OVERHEAD_TOKENS + 1; // bound input 100,001: long
    const calls: RecordedCall[] = [
      ...mixedCalls(),
      { stage: "writeCard", model: "claude-haiku-5-5", tokens: null, bound: { requestBytes: bytes, maxOutputTokens: 3_072, attempts: 3 } },
    ];
    const s = summarizeUsage(calls, AT);
    const record = buildUsageRunRecord(s, CONTEXT, AT, "run-2");
    expect(record.isFloor).toBe(true);
    const ceiling = settleCeilingFor(s, {});
    const worst = 3 * bill(tk({ inputTokens: 100_001, outputTokens: 3_072 }), 0.5, 2.5);
    expect(ceiling as number).toBeCloseTo(realTotal() + worst, 12);
    const settled = settleAmount(5, record, ceiling) as number;
    expect(settled).toBeGreaterThanOrEqual(realTotal() + worst - 1e-12);
    // One byte under: the whole bound is on the short card, and still covers it.
    const s2 = summarizeUsage(
      [{ stage: "writeCard", model: "claude-haiku-5-5", tokens: null, bound: { requestBytes: bytes - 1, maxOutputTokens: 3_072, attempts: 1 } }],
      AT
    );
    expect(s2.unmeasuredBoundUsd as number).toBeCloseTo(bill(tk({ inputTokens: 100_000, outputTokens: 3_072 }), 0.1, 0.5), 15);
  });

  it("the JSONL line round-trips into the cost report with the run's real total", () => {
    const s = summarizeUsage(mixedCalls(), AT);
    const a = buildUsageRunRecord(s, CONTEXT, AT, "run-a");
    const b = buildUsageRunRecord(summarizeUsage(mixedCalls().slice(0, 3), AT), CONTEXT, AT, "run-b");
    const lines = (toJsonlLine(a) + toJsonlLine(b)).split("\n");
    const { records, skipped } = parseUsageRunLines(lines);
    expect(skipped).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0].stages.some((g) => g.model === "claude-haiku-5-5")).toBe(true);
    const report = buildCostReport(records, skipped);
    expect(report.totalRuns).toBe(2);
    expect(report.excludedRuns).toBe(0);
    expect(report.sections).toHaveLength(1);
    const expectedB = h55(SHORT) + h55(LONG) + h45(OLD);
    expect(report.sections[0].billedUsd.mean as number).toBeCloseTo((realTotal() + expectedB) / 2, 12);
    expect(report.pricingVerifiedOn).toEqual(["2026-10-13"]);
    expect(() => renderCostMarkdown(report)).not.toThrow();
  });
});
