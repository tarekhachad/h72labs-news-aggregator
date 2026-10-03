import { describe, it, expect } from "vitest";
import { PRICING, REQUEST_OVERHEAD_TOKENS, summarizeUsage, type RecordedCall } from "@/lib/usage";
import { settleCeilingFor } from "@/lib/usageRecord";
import { settleAmount } from "@/lib/spend";
import { boundOf, createUsageCollector, recordCall, withUsageCollector } from "@/lib/usageCollector";

// A run whose usage went missing for some calls used to settle at its whole
// reservation. These pin the fairer rule: settle at the known total plus each
// usage-less call's proven worst case, never above the reservation, and fall
// back to the whole reservation whenever that worst case can't be proven.

const AT = new Date("2026-10-03T12:00:00Z");
const tokens = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
const haiku = PRICING["claude-haiku-4-5"].list;
const usd = (input: number, output: number) => (input * haiku.inputPerMTok + output * haiku.outputPerMTok) / 1_000_000;

describe("summarizeUsage: unmeasuredBoundUsd", () => {
  it("is 0 when every call reported usage", () => {
    const summary = summarizeUsage([{ stage: "triage", model: "claude-haiku-4-5", tokens: tokens(100, 10) }], AT);
    expect(summary.unmeasuredBoundUsd).toBe(0);
  });

  it("prices a usage-less call at its request bytes plus overhead in, and its output limit out", () => {
    const calls: RecordedCall[] = [
      { stage: "writeCard", model: "claude-haiku-4-5", tokens: null, bound: { requestBytes: 5000, maxOutputTokens: 2048, attempts: 1 } },
    ];
    const summary = summarizeUsage(calls, AT);
    expect(summary.unmeasuredBoundUsd).toBeCloseTo(usd(5000 + REQUEST_OVERHEAD_TOKENS, 2048), 10);
  });

  it("multiplies a call's ceiling by every attempt the SDK may have made", () => {
    const once: RecordedCall = { stage: "writeCard", model: "claude-haiku-4-5", tokens: null, bound: { requestBytes: 5000, maxOutputTokens: 2048, attempts: 1 } };
    const thrice: RecordedCall = { ...once, bound: { requestBytes: 5000, maxOutputTokens: 2048, attempts: 3 } };
    expect(summarizeUsage([thrice], AT).unmeasuredBoundUsd).toBeCloseTo(3 * summarizeUsage([once], AT).unmeasuredBoundUsd!, 10);
  });

  it.each([0, 1.5, Number.NaN])("is null for an attempt count of %s", (attempts) => {
    const calls: RecordedCall[] = [
      { stage: "rank", model: "claude-haiku-4-5", tokens: null, bound: { requestBytes: 10, maxOutputTokens: 10, attempts } },
    ];
    expect(summarizeUsage(calls, AT).unmeasuredBoundUsd).toBeNull();
  });

  it("sums several bounded usage-less calls", () => {
    const one = { stage: "dedup" as const, model: "claude-haiku-4-5" as const, tokens: null, bound: { requestBytes: 1000, maxOutputTokens: 256, attempts: 1 } };
    expect(summarizeUsage([one, one], AT).unmeasuredBoundUsd).toBeCloseTo(2 * usd(1000 + REQUEST_OVERHEAD_TOKENS, 256), 10);
  });

  it.each([
    ["no bound", undefined],
    ["a negative size", { requestBytes: -1, maxOutputTokens: 10, attempts: 1 }],
    ["a non-finite limit", { requestBytes: 10, maxOutputTokens: Number.POSITIVE_INFINITY, attempts: 1 }],
  ])("is null when a usage-less call has %s", (_label, bound) => {
    const calls: RecordedCall[] = [
      { stage: "rank", model: "claude-haiku-4-5", tokens: null, ...(bound ? { bound } : {}) },
      { stage: "rank", model: "claude-haiku-4-5", tokens: null, bound: { requestBytes: 10, maxOutputTokens: 10, attempts: 1 } },
    ];
    expect(summarizeUsage(calls, AT).unmeasuredBoundUsd).toBeNull();
  });

  it("is null when a usage-less call's model can't be priced", () => {
    const table = Object.fromEntries(
      Object.entries(PRICING).filter(([model]) => model !== "claude-haiku-4-5")
    ) as typeof PRICING;
    const calls: RecordedCall[] = [
      { stage: "triage", model: "claude-haiku-4-5", tokens: null, bound: { requestBytes: 10, maxOutputTokens: 10, attempts: 1 } },
    ];
    expect(summarizeUsage(calls, AT, table).unmeasuredBoundUsd).toBeNull();
  });
});

describe("settleCeilingFor", () => {
  const measured = { stage: "writeCard" as const, model: "claude-haiku-4-5" as const, tokens: tokens(1000, 100) };
  const missing = { stage: "writeCard" as const, model: "claude-haiku-4-5" as const, tokens: null, bound: { requestBytes: 4000, maxOutputTokens: 2048, attempts: 1 } };

  it("is null when nothing is missing, so the settle uses the total", () => {
    expect(settleCeilingFor(summarizeUsage([measured], AT), { writeCard: 1 })).toBeNull();
  });

  it("is the total plus the missing call's ceiling", () => {
    const summary = summarizeUsage([measured, missing], AT);
    expect(settleCeilingFor(summary, { writeCard: 2 })).toBeCloseTo(summary.totalBilledUsd + summary.unmeasuredBoundUsd!, 10);
  });

  it("is null when a stage made more calls than were recorded at all", () => {
    expect(settleCeilingFor(summarizeUsage([measured, missing], AT), { writeCard: 3 })).toBeNull();
  });

  it("is null when a usage-less call carries no ceiling", () => {
    const unbounded = { stage: "writeCard" as const, model: "claude-haiku-4-5" as const, tokens: null };
    expect(settleCeilingFor(summarizeUsage([measured, unbounded], AT), { writeCard: 2 })).toBeNull();
  });
});

describe("settleAmount with a ceiling", () => {
  const floor = { totalBilledUsd: 0.36, isFloor: true };

  it("settles a complete run at its total, whatever the ceiling", () => {
    expect(settleAmount(0.7, { totalBilledUsd: 0.36, isFloor: false }, 0.5)).toBe(0.36);
  });

  it("settles a floor run at its ceiling when that's below the reservation", () => {
    expect(settleAmount(0.7, floor, 0.377)).toBeCloseTo(0.377, 10);
  });

  it("never settles above the reservation", () => {
    expect(settleAmount(0.7, floor, 0.95)).toBe(0.7);
  });

  it.each([
    ["no ceiling", null],
    ["a ceiling below the known total", 0.2],
    ["a non-finite ceiling", Number.NaN],
  ])("keeps the whole reservation with %s", (_label, ceiling) => {
    expect(settleAmount(0.7, floor, ceiling)).toBe(0.7);
  });

  it("keeps the known total when it already exceeds the reservation", () => {
    expect(settleAmount(0.7, { totalBilledUsd: 0.8, isFloor: true }, 0.85)).toBe(0.8);
  });

  it("is unchanged for callers that pass no ceiling", () => {
    expect(settleAmount(0.7, floor)).toBe(0.7);
  });
});

describe("boundOf", () => {
  it("measures UTF-8 bytes, which outnumber characters in non-Latin text", () => {
    const text = "المغرب ".repeat(50);
    const params = { max_tokens: 2048, messages: [{ role: "user", content: text }] };
    const bound = boundOf(params, 3);
    expect(bound?.maxOutputTokens).toBe(2048);
    expect(bound!.requestBytes).toBeGreaterThan(text.length);
  });

  it("is undefined when the request can't be serialized", () => {
    const params: { max_tokens: number; self?: unknown } = { max_tokens: 10 };
    params.self = params;
    expect(boundOf(params, 3)).toBeUndefined();
  });

  it("carries the attempt count it is given", () => {
    expect(boundOf({ max_tokens: 10 }, 3)?.attempts).toBe(3);
  });

  it.each([0, 2.5, Number.NaN])("is undefined for an attempt count of %s", (attempts) => {
    expect(boundOf({ max_tokens: 10 }, attempts)).toBeUndefined();
  });

  it("is undefined for a negative output limit", () => {
    expect(boundOf({ max_tokens: -1 }, 3)).toBeUndefined();
  });
});

describe("recordCall keeps the ceiling only where usage is missing", () => {
  const bound = { requestBytes: 500, maxOutputTokens: 100, attempts: 3 };

  it("on a throw", async () => {
    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () =>
      recordCall("dedup", "claude-haiku-4-5", () => Promise.reject(new Error("network")), bound).catch(() => {})
    );
    expect(collector.calls()).toEqual([{ stage: "dedup", model: "claude-haiku-4-5", tokens: null, bound }]);
  });

  it("on a response without usage", async () => {
    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () => recordCall("dedup", "claude-haiku-4-5", async () => ({}), bound));
    expect(collector.calls()).toEqual([{ stage: "dedup", model: "claude-haiku-4-5", tokens: null, bound }]);
  });

  it("not on a call that reported usage", async () => {
    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () =>
      recordCall("dedup", "claude-haiku-4-5", async () => ({ usage: { input_tokens: 10, output_tokens: 2 } }), bound)
    );
    expect(collector.calls()[0]).not.toHaveProperty("bound");
  });
});

describe("the measured 2026-10-03 run", () => {
  it("would have settled near its real cost instead of the whole $0.70 hold", () => {
    // 118 measured calls totalling $0.358654, and one Haiku writeCard call
    // that threw. Its request is generously sized at 8 KB, and counted as all
    // three attempts the SDK may make.
    const measuredTotal = 0.358654;
    const missing: RecordedCall = {
      stage: "writeCard",
      model: "claude-haiku-4-5",
      tokens: null,
      bound: { requestBytes: 8000, maxOutputTokens: 2048, attempts: 3 },
    };
    const summary = summarizeUsage([missing], AT);
    const ceiling = measuredTotal + summary.unmeasuredBoundUsd!;
    const settled = settleAmount(0.7, { totalBilledUsd: measuredTotal, isFloor: true }, ceiling);
    expect(settled).toBeGreaterThan(measuredTotal);
    expect(settled).toBeLessThan(0.45);
  });
});
