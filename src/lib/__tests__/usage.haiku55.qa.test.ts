import { describe, it, expect } from "vitest";
import {
  PRICING,
  REQUEST_OVERHEAD_TOKENS,
  costFor,
  formatCallLine,
  summarizeUsage,
  type CallTokens,
  type ModelPricing,
  type RecordedCall,
  type TrackedModel,
  type UsageStage,
} from "@/lib/usage";
import { settleCeilingFor } from "@/lib/usageRecord";
import { settleAmount } from "@/lib/spend";

// QA (review round 1, Haiku 5.5 switch): the money path must never price a
// run below its real bill. Haiku 5.5's rates are re-typed from the published
// card here, never read off PRICING, so a wrong table can't agree with itself.

const AT = new Date("2026-10-13T12:00:00Z");
const tk = (p: Partial<CallTokens>): CallTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...p,
});

/** Anthropic's Haiku 5.5 bill for ONE request, written out independently. */
function haiku55Bill(t: CallTokens): number {
  const prompt = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  const [inRate, outRate] = prompt > 100_000 ? [0.5, 2.5] : [0.1, 0.5];
  return (
    (t.inputTokens * inRate + t.cacheReadTokens * inRate * 0.1 + t.cacheWriteTokens * inRate * 1.25 + t.outputTokens * outRate) /
    1_000_000
  );
}
/** Haiku 4.5 ($1/$5) and Sonnet 5 ($2/$10): single card at any length. */
function flatBill(t: CallTokens, inRate: number, outRate: number): number {
  return (
    (t.inputTokens * inRate + t.cacheReadTokens * inRate * 0.1 + t.cacheWriteTokens * inRate * 1.25 + t.outputTokens * outRate) /
    1_000_000
  );
}
function realBill(model: TrackedModel, t: CallTokens): number {
  if (model === "claude-haiku-5-5") return haiku55Bill(t);
  if (model === "claude-haiku-4-5") return flatBill(t, 1, 5);
  return flatBill(t, 2, 10);
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("Haiku 5.5: the boundary, cache tokens included", () => {
  const cases: [string, CallTokens, "short" | "long"][] = [
    ["input alone at exactly 100,000", tk({ inputTokens: 100_000, outputTokens: 500 }), "short"],
    ["input alone at 100,001", tk({ inputTokens: 100_001, outputTokens: 500 }), "long"],
    ["cache read making exactly 100,000", tk({ inputTokens: 40_000, cacheReadTokens: 60_000, outputTokens: 500 }), "short"],
    ["cache read making 100,001", tk({ inputTokens: 40_001, cacheReadTokens: 60_000, outputTokens: 500 }), "long"],
    ["cache write making 100,001", tk({ inputTokens: 1, cacheWriteTokens: 100_000 }), "long"],
    ["all three making 100,001", tk({ inputTokens: 1, cacheReadTokens: 50_000, cacheWriteTokens: 50_000 }), "long"],
    ["output never counts toward the prompt", tk({ inputTokens: 100_000, outputTokens: 900_000 }), "short"],
  ];
  it.each(cases)("%s", (_name, t, card) => {
    const cost = costFor("claude-haiku-5-5", t, AT);
    expect(cost.billedUsd).toBeCloseTo(haiku55Bill(t), 15);
    expect(cost.listUsd).toBe(cost.billedUsd);
    const shortCard = flatBill(t, 0.1, 0.5);
    if (card === "long") expect(cost.billedUsd).toBeCloseTo(shortCard * 5, 15);
    else expect(cost.billedUsd).toBeCloseTo(shortCard, 15);
  });

  it("formatCallLine prints the same per-call figure on each side of the boundary", () => {
    for (const inputTokens of [100_000, 100_001]) {
      const t = tk({ inputTokens, outputTokens: 1_000 });
      const line = formatCallLine({ stage: "triage", model: "claude-haiku-5-5", tokens: t }, AT);
      expect(line).toContain(`$${haiku55Bill(t).toFixed(6)}`);
    }
  });
});

describe("summarizeUsage never prices a run below the sum of its per-call bills", () => {
  const MODELS_: TrackedModel[] = ["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-5"];
  const STAGES: UsageStage[] = ["triage", "writeCard", "expand", "merge"];

  it("over 300 random runs, mixed models in one stage, inputs clustered on the boundary", () => {
    const r = rng(20261013);
    for (let run = 0; run < 300; run++) {
      const calls: RecordedCall[] = [];
      const n = 1 + Math.floor(r() * 25);
      for (let i = 0; i < n; i++) {
        const near = r() < 0.5;
        const prompt = near ? 100_000 + Math.floor(r() * 7) - 3 : Math.floor(r() * 250_000);
        const read = Math.floor(r() * Math.min(prompt, 60_000) * (r() < 0.3 ? 1 : 0));
        const write = Math.floor(r() * (prompt - read) * (r() < 0.3 ? 1 : 0));
        calls.push({
          stage: STAGES[Math.floor(r() * STAGES.length)],
          model: MODELS_[Math.floor(r() * MODELS_.length)],
          tokens: tk({ inputTokens: prompt - read - write, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: Math.floor(r() * 5_000) }),
        });
      }
      const expected = calls.reduce((sum, c) => sum + realBill(c.model, c.tokens as CallTokens), 0);
      const s = summarizeUsage(calls, AT);
      expect(s.unpricedModels).toEqual([]);
      // Exact (to float noise), and in particular never under.
      expect(Math.abs(s.totalBilledUsd - expected)).toBeLessThan(1e-12 * Math.max(1, expected) + 1e-15);
      expect(s.totalListUsd).toBeCloseTo(s.totalBilledUsd, 12);
      for (const g of s.stages) {
        const own = calls
          .filter((c) => c.stage === g.stage && c.model === g.model)
          .reduce((sum, c) => sum + realBill(c.model, c.tokens as CallTokens), 0);
        expect(g.cost.billedUsd).toBeCloseTo(own, 12);
      }
    }
  });

  it("a group of one long call and many short ones: long priced long, short priced short", () => {
    const shortT = tk({ inputTokens: 99_999, outputTokens: 100 });
    const longT = tk({ inputTokens: 100_001, outputTokens: 100 });
    const calls: RecordedCall[] = [
      { stage: "triage", model: "claude-haiku-5-5", tokens: shortT },
      { stage: "triage", model: "claude-haiku-5-5", tokens: longT },
      { stage: "triage", model: "claude-haiku-5-5", tokens: shortT },
    ];
    const s = summarizeUsage(calls, AT);
    expect(s.stages).toHaveLength(1);
    expect(s.totalBilledUsd).toBeCloseTo(2 * haiku55Bill(shortT) + haiku55Bill(longT), 15);
  });
});

describe("usage-less Haiku 5.5 calls: the settle ceiling covers the worst real bill", () => {
  const bounded = (requestBytes: number, maxOutputTokens: number, attempts = 3): RecordedCall => ({
    stage: "writeCard",
    model: "claude-haiku-5-5",
    tokens: null,
    bound: { requestBytes, maxOutputTokens, attempts },
  });

  it.each([1_000, 100_000 - REQUEST_OVERHEAD_TOKENS, 100_000 - REQUEST_OVERHEAD_TOKENS + 1, 400_000])(
    "requestBytes %i: ceiling >= every bill the bound allows, and settleAmount never goes below it",
    (bytes) => {
      const known: RecordedCall = { stage: "triage", model: "claude-haiku-5-5", tokens: tk({ inputTokens: 150_000, outputTokens: 2_000 }) };
      const unknown = bounded(bytes, 3_072);
      const s = summarizeUsage([known, unknown], AT);
      const ceiling = settleCeilingFor(s, {});
      expect(ceiling).not.toBeNull();
      // The worst real bill for the usage-less call: every attempt billed, at
      // the most input the bound allows (cost is monotone in input, and the
      // long card only raises it).
      const worst = 3 * haiku55Bill(tk({ inputTokens: bytes + REQUEST_OVERHEAD_TOKENS, outputTokens: 3_072 }));
      const knownBill = haiku55Bill(known.tokens as CallTokens);
      expect(ceiling as number).toBeGreaterThanOrEqual(knownBill + worst - 1e-15);
      // Spot-check a few smaller realisations of the same bound.
      for (const input of [0, 50_000, 99_999, 100_000, 100_001, bytes + REQUEST_OVERHEAD_TOKENS]) {
        if (input > bytes + REQUEST_OVERHEAD_TOKENS) continue;
        for (const read of [0, Math.floor(input / 2)]) {
          const real = 3 * haiku55Bill(tk({ inputTokens: input - read, cacheReadTokens: read, outputTokens: 3_072 }));
          expect(ceiling as number).toBeGreaterThanOrEqual(knownBill + real - 1e-15);
        }
      }
      const reserved = 10;
      const settled = settleAmount(reserved, { totalBilledUsd: s.totalBilledUsd, isFloor: true }, ceiling);
      expect(settled).not.toBeNull();
      expect(settled as number).toBeGreaterThanOrEqual(knownBill + worst - 1e-15);
      expect(settled as number).toBeLessThanOrEqual(reserved);
    }
  );
});

describe("a malformed long-context entry is never priced on the cheap card", () => {
  const base = PRICING["claude-haiku-5-5"];
  const withLong = (longContext: unknown): Record<TrackedModel, ModelPricing> =>
    ({ ...PRICING, "claude-haiku-5-5": { ...base, longContext } }) as Record<TrackedModel, ModelPricing>;
  const longCall: RecordedCall = { stage: "expand", model: "claude-haiku-5-5", tokens: tk({ inputTokens: 150_000, outputTokens: 1_000 }) };
  const shortCall: RecordedCall = { stage: "expand", model: "claude-haiku-5-5", tokens: tk({ inputTokens: 1_000, outputTokens: 100 }) };
  const realLong = haiku55Bill(longCall.tokens as CallTokens);

  it.each([
    ["aboveTokens NaN", { aboveTokens: NaN, rate: base.longContext?.rate }],
    ["aboveTokens Infinity", { aboveTokens: Infinity, rate: base.longContext?.rate }],
    ["aboveTokens -Infinity", { aboveTokens: -Infinity, rate: base.longContext?.rate }],
    ["aboveTokens a string", { aboveTokens: "100000", rate: base.longContext?.rate }],
    ["aboveTokens null", { aboveTokens: null, rate: base.longContext?.rate }],
    ["rate null", { aboveTokens: 100_000, rate: null }],
    ["longContext null", null],
    ["longContext a number", 5],
  ])("%s: a long call is unpriced or priced at least at its real bill", (_name, entry) => {
    const s = summarizeUsage([longCall, shortCall], AT, withLong(entry));
    const priced = s.unpricedModels.length === 0;
    if (priced) expect(s.totalBilledUsd).toBeGreaterThanOrEqual(realLong + haiku55Bill(shortCall.tokens as CallTokens) - 1e-15);
    else expect(s.stages[0].priced).toBe(false);
  });
});
