import { describe, it, expect } from "vitest";
import { PRICING, REQUEST_OVERHEAD_TOKENS, summarizeUsage, type ModelPricing, type RecordedCall, type TrackedModel } from "@/lib/usage";
import { settleCeilingFor } from "@/lib/usageRecord";
import { settleAmount } from "@/lib/spend";
import { boundOf } from "@/lib/usageCollector";

// QA (v2.4-fair-settle, rounds 1-2). Gaps the shipped suite let through under mutation.

const AT = new Date("2026-10-03T12:00:00Z");
const bounded = (model: TrackedModel, requestBytes: number, maxOutputTokens: number, attempts = 1): RecordedCall => ({
  stage: "writeCard",
  model,
  tokens: null,
  bound: { requestBytes, maxOutputTokens, attempts },
});

describe("settleCeilingFor refuses a ceiling when a measured call's model is unpriced", () => {
  it("is null even though every usage-less call is bounded and priced", () => {
    // Sonnet unpriced: its measured tokens add $0 to the total, so total +
    // bounds would understate the run.
    const table = { "claude-haiku-4-5": PRICING["claude-haiku-4-5"] } as Record<TrackedModel, ModelPricing>;
    const calls: RecordedCall[] = [
      { stage: "writeCard", model: "claude-sonnet-5", tokens: { inputTokens: 50_000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      bounded("claude-haiku-4-5", 1000, 256),
    ];
    const summary = summarizeUsage(calls, AT, table);
    expect(summary.unmeasuredBoundUsd).not.toBeNull();
    expect(summary.unpricedModels).toEqual(["claude-sonnet-5"]);
    expect(settleCeilingFor(summary, { writeCard: 2 })).toBeNull();
  });
});

describe("addBoundCost guards", () => {
  it("is null for a negative output limit (it would lower the ceiling)", () => {
    const calls = [bounded("claude-haiku-4-5", 1000, -500)];
    expect(summarizeUsage(calls, AT).unmeasuredBoundUsd).toBeNull();
  });

  it("prices a bound at list when a promotion is dearer than list", () => {
    const dearPromo: ModelPricing = {
      list: PRICING["claude-haiku-4-5"].list,
      promo: {
        rate: { ...PRICING["claude-haiku-4-5"].list, inputPerMTok: 10, outputPerMTok: 50 },
        fromUtcDate: "2026-01-01",
        throughUtcDate: "2026-12-31",
      },
    };
    const table = { ...PRICING, "claude-haiku-4-5": dearPromo } as Record<TrackedModel, ModelPricing>;
    const got = summarizeUsage([bounded("claude-haiku-4-5", 1000, 100)], AT, table).unmeasuredBoundUsd!;
    // The dearer of the two, i.e. the promo here.
    const promoCost = ((1000 + REQUEST_OVERHEAD_TOKENS) * 10 + 100 * 50) / 1_000_000;
    expect(got).toBeCloseTo(promoCost, 12);
  });

  it("prices at list when the promotion is cheaper (never below list)", () => {
    const cheapPromo: ModelPricing = {
      list: PRICING["claude-haiku-4-5"].list,
      promo: {
        rate: { ...PRICING["claude-haiku-4-5"].list, inputPerMTok: 0.1, outputPerMTok: 0.5 },
        fromUtcDate: "2026-01-01",
        throughUtcDate: "2026-12-31",
      },
    };
    const table = { ...PRICING, "claude-haiku-4-5": cheapPromo } as Record<TrackedModel, ModelPricing>;
    const got = summarizeUsage([bounded("claude-haiku-4-5", 1000, 100)], AT, table).unmeasuredBoundUsd!;
    const listCost = ((1000 + REQUEST_OVERHEAD_TOKENS) * 1 + 100 * 5) / 1_000_000;
    expect(got).toBeCloseTo(listCost, 12);
  });
});

describe("REQUEST_OVERHEAD_TOKENS", () => {
  it("is a real margin, not zero", () => {
    // Covers framing and the structured-output instructions the serialized
    // request doesn't contain. Pinned so it can't silently drop to 0.
    expect(REQUEST_OVERHEAD_TOKENS).toBeGreaterThanOrEqual(1024);
  });
});

describe("boundOf counts UTF-8 bytes exactly", () => {
  it("equals the byte length of the serialized params, not its character count", () => {
    const params = { max_tokens: 10, messages: [{ role: "user", content: "المغرب “quoted” é" }] };
    const json = JSON.stringify(params);
    expect(boundOf(params, 3)!.requestBytes).toBe(Buffer.byteLength(json, "utf8"));
    expect(boundOf(params, 3)!.requestBytes).toBeGreaterThan(json.length);
  });

  it("is undefined for a NaN output limit", () => {
    expect(boundOf({ max_tokens: Number.NaN }, 3)).toBeUndefined();
  });
});

describe("attempts: the multiplier and its guards", () => {
  it("weights each usage-less call by its own attempt count", () => {
    const a = summarizeUsage([bounded("claude-haiku-4-5", 1000, 256, 1)], AT).unmeasuredBoundUsd!;
    const b = summarizeUsage([bounded("claude-sonnet-5", 4000, 2048, 1)], AT).unmeasuredBoundUsd!;
    const mixed = summarizeUsage([bounded("claude-haiku-4-5", 1000, 256, 3), bounded("claude-sonnet-5", 4000, 2048, 2)], AT).unmeasuredBoundUsd!;
    expect(mixed).toBeCloseTo(3 * a + 2 * b, 12);
  });

  it("an attempt count of exactly 1 is accepted, not treated as missing", () => {
    expect(summarizeUsage([bounded("claude-haiku-4-5", 10, 10, 1)], AT).unmeasuredBoundUsd).not.toBeNull();
    expect(boundOf({ max_tokens: 10 }, 1)?.attempts).toBe(1);
  });

  it.each([0, -1, -3, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2.0000001])("addBoundCost refuses attempts=%s", (attempts) => {
    expect(summarizeUsage([bounded("claude-haiku-4-5", 10, 10, attempts)], AT).unmeasuredBoundUsd).toBeNull();
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, 0.5])("boundOf refuses attempts=%s", (attempts) => {
    expect(boundOf({ max_tokens: 10 }, attempts)).toBeUndefined();
  });

  it("an attempt count that is not a number at all is refused at both layers", () => {
    expect(boundOf({ max_tokens: 10 }, "3" as unknown as number)).toBeUndefined();
    expect(summarizeUsage([bounded("claude-haiku-4-5", 10, 10, "3" as unknown as number)], AT).unmeasuredBoundUsd).toBeNull();
    // A bound recorded before the field existed (no attempts at all).
    const legacy: RecordedCall = { stage: "writeCard", model: "claude-haiku-4-5", tokens: null, bound: { requestBytes: 10, maxOutputTokens: 10 } as never };
    expect(summarizeUsage([legacy], AT).unmeasuredBoundUsd).toBeNull();
  });

  it("a client whose maxRetries isn't a number yields no bound, so the run keeps its reservation", () => {
    // What a call site computes as client.maxRetries + 1 when maxRetries is missing or a string.
    const missing = (undefined as unknown as number) + 1;
    const stringy = ("2" as unknown as number) + 1;
    expect(boundOf({ max_tokens: 10 }, missing)).toBeUndefined();
    expect(boundOf({ max_tokens: 10 }, stringy)).toBeUndefined();
    const call: RecordedCall = { stage: "dedup", model: "claude-haiku-4-5", tokens: null };
    const summary = summarizeUsage([call], AT);
    const ceiling = settleCeilingFor(summary, { dedup: 1 });
    expect(ceiling).toBeNull();
    expect(settleAmount(0.7, { totalBilledUsd: summary.totalBilledUsd, isFloor: true }, ceiling)).toBe(0.7);
  });
});
