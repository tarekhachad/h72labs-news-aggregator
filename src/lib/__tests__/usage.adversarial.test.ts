/**
 * Adversarial probes against usage.ts's pricing guarantees.
 *
 * PERMANENT — do not delete. Written by the `qa` subagent as review
 * **Do not delete these as scaffolding.** Mutation testing shows this file and
 * usage.round3.test.ts are the sole coverage for 23 mutants across the
 * hardening in this module. Remove them and reverting the prototype-pollution
 * guard, the null-entry guard, deepFreezePricing, billedAtList, the per-group
 * pricing isolation or the FLOOR warning all leave the suite green.
 *
 * Losing this file and losing those guarantees are the same event.
 *
 * Sections: A independent arithmetic (a second oracle, constants re-typed from
 * the published rates rather than imported); B constructing a wrong number
 * through the injected pricing table; C the blast radius of a pricing failure;
 * D footer and tripwire claims; E a promoted model that cannot be priced;
 * F an unusable priced instant; G the states where those last two overlap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRICING,
  PRICING_VERIFIED_ON,
  costFor,
  formatUsageSummary,
  formatUsd,
  summarizeUsage,
  type CallTokens,
  type ModelPricing,
  type RecordedCall,
  type TrackedModel,
} from "@/lib/usage";
import { createUsageCollector } from "@/lib/usageCollector";

const AT = new Date("2026-09-11T12:00:00Z");

function tk(p: Partial<CallTokens> = {}): CallTokens {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...p };
}

function call(stage: RecordedCall["stage"], model: TrackedModel, t: CallTokens): RecordedCall {
  return { stage, model, tokens: t };
}

/* ------------------------------------------------------------------ *
 * A. Independent arithmetic. Constants re-typed from the stated spec
 *    (Sonnet $2/$10, Haiku $1/$5, cache read 0.1x in, cache write 1.25x
 *    in), NOT read off PRICING, so a wrong table cannot agree with itself.
 * ------------------------------------------------------------------ */
const SPEC: Record<TrackedModel, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
};

function oracleUsd(model: TrackedModel, t: CallTokens): number {
  const { in: i, out: o } = SPEC[model];
  return (
    (t.inputTokens * i + t.cacheWriteTokens * i * 1.25 + t.cacheReadTokens * i * 0.1 + t.outputTokens * o) /
    1_000_000
  );
}

describe("A. arithmetic, re-derived independently of the table", () => {
  const shapes: [string, CallTokens][] = [
    ["input only", tk({ inputTokens: 1_000_000 })],
    ["output only", tk({ outputTokens: 1_000_000 })],
    ["cache read only", tk({ cacheReadTokens: 1_000_000 })],
    ["cache write only", tk({ cacheWriteTokens: 1_000_000 })],
    ["all four at once", tk({ inputTokens: 123_456, outputTokens: 7_890, cacheReadTokens: 654_321, cacheWriteTokens: 4_242 })],
    ["one token of each", tk({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 })],
    ["all zero", tk()],
    ["realistic triage call", tk({ inputTokens: 2_400, outputTokens: 180 })],
  ];

  for (const model of ["claude-haiku-4-5", "claude-sonnet-5"] as const) {
    for (const [name, t] of shapes) {
      it(`${model}: ${name}`, () => {
        const cost = costFor(model, t, AT);
        expect(cost.listUsd).toBeCloseTo(oracleUsd(model, t), 12);
        // No promo lives in the real table today, so these must be identical.
        expect(cost.billedUsd).toBe(cost.listUsd);
      });
    }
  }

  it("pins the four live rates as exact literals", () => {
    const oneM = tk({ inputTokens: 1_000_000 });
    const oneMOut = tk({ outputTokens: 1_000_000 });
    expect(costFor("claude-haiku-4-5", oneM, AT).listUsd).toBeCloseTo(1.0, 12);
    expect(costFor("claude-haiku-4-5", oneMOut, AT).listUsd).toBeCloseTo(5.0, 12);
    expect(costFor("claude-sonnet-5", oneM, AT).listUsd).toBeCloseTo(2.0, 12);
    expect(costFor("claude-sonnet-5", oneMOut, AT).listUsd).toBeCloseTo(10.0, 12);
  });

  it("cache multipliers scale off the INPUT rate, not the output rate", () => {
    // A plausible wrong implementation multiplies the blended or output rate.
    // Sonnet in=$2: 1M cache-read tokens must be $0.20, not $1.00.
    expect(costFor("claude-sonnet-5", tk({ cacheReadTokens: 1_000_000 }), AT).listUsd).toBeCloseTo(0.2, 12);
    expect(costFor("claude-sonnet-5", tk({ cacheWriteTokens: 1_000_000 }), AT).listUsd).toBeCloseTo(2.5, 12);
  });

  it("is additive across token kinds (no double counting)", () => {
    const a = tk({ inputTokens: 500_000 });
    const b = tk({ outputTokens: 300_000, cacheReadTokens: 900_000 });
    const both = tk({ inputTokens: 500_000, outputTokens: 300_000, cacheReadTokens: 900_000 });
    const sum = costFor("claude-sonnet-5", a, AT).listUsd + costFor("claude-sonnet-5", b, AT).listUsd;
    expect(costFor("claude-sonnet-5", both, AT).listUsd).toBeCloseTo(sum, 12);
  });
});

/* ------------------------------------------------------------------ *
 * B. Trying to construct a confidently-wrong number through the new
 *    4-arg signature.
 * ------------------------------------------------------------------ */
function promoTable(promoRate: Partial<ModelPricing["promo"]> & { rate: ModelPricing["list"] }): Record<TrackedModel, ModelPricing> {
  return {
    "claude-haiku-4-5": PRICING["claude-haiku-4-5"],
    "claude-sonnet-5": {
      list: { inputPerMTok: 3, outputPerMTok: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
      promo: {
        fromUtcDate: "2026-01-01",
        throughUtcDate: "2026-12-31",
        ...promoRate,
      } as NonNullable<ModelPricing["promo"]>,
    },
  };
}

const CHEAP = { inputPerMTok: 2, outputPerMTok: 10, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };
const DEARER = { inputPerMTok: 9, outputPerMTok: 45, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };
const SAME = { inputPerMTok: 3, outputPerMTok: 15, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 };

describe("B. attempts to produce a wrong number through the table argument", () => {
  const t = tk({ inputTokens: 1_000_000, outputTokens: 1_000_000 });

  it("B1: a model+table mismatch is no longer expressible — model alone decides", () => {
    const table = promoTable({ rate: CHEAP });
    // Haiku priced against a table whose Sonnet entry is wildly different.
    expect(costFor("claude-haiku-4-5", t, AT, table).listUsd).toBeCloseTo(6, 12);
    expect(costFor("claude-sonnet-5", t, AT, table).listUsd).toBeCloseTo(18, 12);
  });

  it("B2: a prototype-polluted table does NOT silently supply a price", () => {
    // normalizeUsage() defends against exactly this with Object.hasOwn and
    // says so in its docstring. The table lookup is the money path; it should
    // hold the same line rather than inherit a rate from Object.prototype.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto["claude-sonnet-5"] = {
        list: { inputPerMTok: 999, outputPerMTok: 999, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
      };
      const partial = { "claude-haiku-4-5": PRICING["claude-haiku-4-5"] } as unknown as Record<
        TrackedModel,
        ModelPricing
      >;
      expect(() => costFor("claude-sonnet-5", t, AT, partial)).toThrow(/no pricing entry/);
    } finally {
      delete proto["claude-sonnet-5"];
    }
  });

  it("B3: a null-prototype table still prices normally", () => {
    const bare = Object.assign(Object.create(null), PRICING) as Record<TrackedModel, ModelPricing>;
    expect(costFor("claude-sonnet-5", t, AT, bare).listUsd).toBeCloseTo(12, 12);
  });

  it("B4: a deeply frozen table prices normally and is not mutated", () => {
    const frozen = Object.freeze({
      "claude-haiku-4-5": Object.freeze({ list: Object.freeze({ ...PRICING["claude-haiku-4-5"].list }) }),
      "claude-sonnet-5": Object.freeze({ list: Object.freeze({ ...PRICING["claude-sonnet-5"].list }) }),
    }) as Record<TrackedModel, ModelPricing>;
    expect(costFor("claude-sonnet-5", t, AT, frozen).listUsd).toBeCloseTo(12, 12);
    expect(summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, frozen).totalBilledUsd).toBeCloseTo(12, 12);
  });

  it("B5: an entry explicitly set to undefined throws by name, not TypeError", () => {
    const table = { ...PRICING, "claude-sonnet-5": undefined } as unknown as Record<TrackedModel, ModelPricing>;
    expect(() => costFor("claude-sonnet-5", t, AT, table)).toThrow(/no pricing entry for model claude-sonnet-5/);
  });

  it("B6: an entry set to null throws something NAMED, not a bare TypeError", () => {
    // `=== undefined` does not catch null; the next line reads pricing.list.
    const table = { ...PRICING, "claude-sonnet-5": null } as unknown as Record<TrackedModel, ModelPricing>;
    expect(() => costFor("claude-sonnet-5", t, AT, table)).toThrow(/no pricing entry for model claude-sonnet-5/);
  });

  it("B7: a promo priced ABOVE list must never be reported as 'billed is list price'", () => {
    const table = promoTable({ rate: DEARER });
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, table);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    // billed ($54) is strictly above list ($18) here.
    expect(summary.totalBilledUsd).toBeGreaterThan(summary.totalListUsd);
    // The footer calls a SURCHARGE "introductory pricing ... in effect", which
    // is the one direction of wrongness this module is built to refuse.
    expect(text).not.toContain("introductory pricing was in effect");
  });

  it("B8: costFor and summarizeUsage must agree on whether a promo applied", () => {
    // Same table, same instant, same model — two 'applied' answers is the
    // divergence the round-1 single-lookup-path fix was meant to end.
    // `applied` deliberately does NOT mean `costFor(...).promoApplied` (window
    // open AND billed < list). That single boolean is wrong in both directions
    // in turn, so the meaning is split:
    //   applied    = the promo WINDOW was open   (costFor's promoLive)
    //   discounted = it actually reduced spend    (costFor's promoApplied)
    // The break that forced it: a stage whose calls all reported no usage
    // aggregates to zero tokens, `0 < 0` is false, and the footer announced
    // "introductory pricing is not in effect" in the middle of a live promo —
    // a false claim about Anthropic's rate card caused by this app failing to
    // read a usage payload.
    const table = promoTable({ rate: DEARER });
    const cost = costFor("claude-sonnet-5", t, AT, table);
    const notice = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, table).promos[0];
    // Still one evaluation each, still sourced from costFor — which is what
    // this test was originally guarding. Two fields, not two evaluations.
    expect(notice.applied).toBe(cost.promoLive);
    expect(notice.discounted).toBe(cost.promoApplied);
    // A dearer promo is live but not a discount. That pair is the whole point.
    expect(notice.applied).toBe(true);
    expect(notice.discounted).toBe(false);

    // The `applied` assertion above cannot distinguish `promoLive` from an
    // independent date evaluation — for DEARER they agree. This case can: an
    // unusable instant makes utcDateString return null, so promoLive is false
    // ("not confirmably live") while a naive date check would throw or guess.
    const badClock = costFor("claude-sonnet-5", t, new Date(NaN), table);
    const badNotice = summarizeUsage(
      [call("writeCard", "claude-sonnet-5", t)],
      new Date(NaN),
      table
    ).promos[0];
    expect(badNotice.applied).toBe(badClock.promoLive);
    expect(badNotice.applied).toBe(false);
  });

  it("B9: a promo identical to list is not claimed as a discount", () => {
    const table = promoTable({ rate: SAME });
    const cost = costFor("claude-sonnet-5", t, AT, table);
    expect(cost.billedUsd).toBe(cost.listUsd);
    expect(cost.promoApplied).toBe(false);
  });

  it("B10: an inverted promo window (from > through) never applies", () => {
    const table = promoTable({ rate: CHEAP, fromUtcDate: "2026-12-31", throughUtcDate: "2026-01-01" });
    const cost = costFor("claude-sonnet-5", t, AT, table);
    expect(cost.promoApplied).toBe(false);
    expect(cost.billedUsd).toBe(cost.listUsd);
  });

  it("B11: a malformed (non-ISO) promo window cannot earn a discount", () => {
    // Lexicographic comparison is only chronological for zero-padded ISO.
    // "2026-9-1" sorts ABOVE "2026-09-11", so a sloppy entry could widen or
    // narrow the window silently.
    const table = promoTable({ rate: CHEAP, fromUtcDate: "2026-9-1", throughUtcDate: "2026-9-30" });
    const cost = costFor("claude-sonnet-5", t, AT, table);
    // "2026-09-11" >= "2026-9-1" is FALSE lexicographically, so no discount —
    // erring toward list, which is the safe direction. Pinning it so a future
    // change that starts accepting loose dates has to be deliberate.
    expect(cost.billedUsd).toBe(cost.listUsd);
  });

  it("B12: an unusable clock prices at list for every model alike", () => {
    const table = promoTable({ rate: CHEAP });
    const cost = costFor("claude-sonnet-5", t, new Date(NaN), table);
    expect(cost.billedUsd).toBe(cost.listUsd);
    expect(cost.promoApplied).toBe(false);
  });

  it("B13: extra keys in the table are inert", () => {
    const table = { ...PRICING, "claude-opus-9": { list: { inputPerMTok: 99, outputPerMTok: 99, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 } } } as unknown as Record<TrackedModel, ModelPricing>;
    expect(costFor("claude-sonnet-5", t, AT, table).listUsd).toBeCloseTo(12, 12);
  });

  it("B14: the exported PRICING table cannot be mutated by a consumer", () => {
    // ZERO_TOKENS is frozen with an explicit shared-mutable-state rationale.
    // PRICING is the money table and is exported from the same module.
    // ESM is strict mode, so a write to a frozen property throws rather than
    // failing silently — assert the throw, then assert the number is intact.
    const before = costFor("claude-sonnet-5", tk({ inputTokens: 1_000_000 }), AT).listUsd;
    expect(() => {
      (PRICING["claude-sonnet-5"].list as { inputPerMTok: number }).inputPerMTok = 500;
    }).toThrow(TypeError);
    expect(costFor("claude-sonnet-5", tk({ inputTokens: 1_000_000 }), AT).listUsd).toBe(before);
  });

  it("B15: the freeze reaches every nesting level, including a promo rate", () => {
    // Object.freeze is shallow. A frozen top level with a mutable nested Rate
    // is the version of this guard that looks right and isn't.
    expect(Object.isFrozen(PRICING)).toBe(true);
    for (const m of ["claude-haiku-4-5", "claude-sonnet-5"] as const) {
      expect(Object.isFrozen(PRICING[m])).toBe(true);
      expect(Object.isFrozen(PRICING[m].list)).toBe(true);
      const promo = PRICING[m].promo;
      if (promo !== undefined) {
        expect(Object.isFrozen(promo)).toBe(true);
        expect(Object.isFrozen(promo.rate)).toBe(true);
      }
    }
  });

  it("B16: adding a new model key to PRICING is rejected", () => {
    expect(() => {
      (PRICING as unknown as Record<string, unknown>)["claude-opus-9"] = { list: {} };
    }).toThrow(TypeError);
    expect(Object.hasOwn(PRICING, "claude-opus-9")).toBe(false);
  });

  it("B17: a dearer-than-list promo is reported as a WARNING, not as a discount", () => {
    const table = promoTable({ rate: DEARER });
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, table);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(summary.totalBilledUsd).toBeGreaterThan(summary.totalListUsd);
    // Live window, no discount — see the contract note on B8.
    expect(summary.promos[0].applied).toBe(true);
    expect(summary.promos[0].discounted).toBe(false);
    expect(summary.promos[0].billedAtList).toBe(false);
    expect(text).toContain("NOT cheaper than list");
    expect(text).not.toContain("billed is list price");
    expect(text).not.toContain("introductory pricing was in effect");
  });

  it("B18: a lapsed promo still reports billedAtList and the plain footer", () => {
    const table = promoTable({ rate: CHEAP, fromUtcDate: "2026-01-01", throughUtcDate: "2026-02-01" });
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, table);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(summary.promos[0].applied).toBe(false);
    expect(summary.promos[0].billedAtList).toBe(true);
    expect(text).toContain("is not in effect for this run; billed is list price");
    expect(text).not.toContain("NOT cheaper than list");
  });
});

/* ------------------------------------------------------------------ *
 * C. Can the new named throw strand anything?
 * ------------------------------------------------------------------ */
describe("C. the named throw's blast radius", () => {
  afterEach(() => vi.restoreAllMocks());

  const t = tk({ inputTokens: 1000, outputTokens: 1000 });
  const UNPRICED = "claude-opus-9" as unknown as TrackedModel;

  it("C1: an unpriceable model is never folded into the totals as $0", () => {
    // summarizeUsage now catches per-group and marks `priced: false` rather
    // than propagating. The group's `cost` is then left at its zero seed, and
    // that zero is summed into totalBilledUsd / totalListUsd unconditionally.
    const summary = summarizeUsage([call("writeCard", UNPRICED, t)], AT);
    expect(summary.stages[0].priced).toBe(false);
    // The zero stays in the total by design — there is no honest number to
    // put there — but it must never be presented as a complete figure. That
    // is what `unpricedModels` + the formatter's FLOOR warning are for, and
    // C1b is what holds them to it.
    expect(summary.totalBilledUsd).toBe(0);
    expect(summary.unpricedModels).toEqual([UNPRICED]);
  });

  it("C1b: the rendered summary must warn when a stage could not be priced", () => {
    // summarizeUsage's own comment claims these zeros are "forced into the
    // FLOOR warning by the formatter". formatUsageSummary reads neither
    // `priced` nor `unpricedModels`; its FLOOR warning is gated only on
    // totalCallsWithoutUsage, which is 0 here because the call WAS measured.
    const summary = summarizeUsage([call("writeCard", UNPRICED, t)], AT);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(summary.unpricedModels).toEqual([UNPRICED]);
    // Asserted by substance, not by literal phrasing. The wording changed once
    // already. Do NOT word it as "no pricing entry ... Add the model to
    // PRICING": that over-diagnoses, since a table entry of `{ list: null }`
    // has the model present but malformed, so the remedy would be wrong. What must hold is
    // that the model is named, the zero is explicitly not a claim of "free",
    // and the totals are labelled a FLOOR.
    expect(text).toContain("WARNING");
    expect(text).toContain(UNPRICED);
    expect(text).toContain("UNKNOWN, not because they were free");
    expect(text).toContain("FLOOR");
    // The $0 must be explicitly disclaimed, not left to the reader.
    expect(text).toContain("UNKNOWN, not because they were free");
    expect(text).toContain("FLOOR");
  });

  it("C1c: an unpriced stage must not silently erase a priced stage's total", () => {
    const summary = summarizeUsage(
      [call("triage", "claude-haiku-4-5", t), call("writeCard", UNPRICED, t)],
      AT
    );
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    // Haiku's 1000 in + 1000 out = $0.006. The unpriceable stage's spend is
    // missing from the total, which is exactly why the FLOOR warning and the
    // named model below have to be present for the number to be readable.
    expect(summary.totalBilledUsd).toBeCloseTo(0.006, 12);
    expect(text).toContain("FLOOR");
    expect(text).toContain("claude-opus-9");
  });

  it("C2: collector.report() must not go completely silent when pricing lookup fails", () => {
    // This is the scenario the named error was introduced for. report()
    // wraps everything in try/catch with an empty handler, so the question
    // is whether the NAME reaches any output channel at all.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const collector = createUsageCollector(AT);
    collector.add({ stage: "writeCard", model: UNPRICED, tokens: t });
    expect(() => collector.report({ label: "digest complete" })).not.toThrow();

    // NOT `expect(printed).not.toBe("")`. That was this test's original
    // assertion, and that would be a false pass: because the per-group catch
    // means an unpriceable model no longer throws out of
    // formatUsageSummary, the ordinary console.log table makes `printed`
    // non-empty whether or not any diagnostic was emitted. Verified — it
    // passed with the console.error line deleted. Assert the specific channel
    // and the specific content instead.
    //
    // The path actually exercised here is add()'s, not report()'s:
    // formatCallLine prices the call, so an unpriceable model throws there and
    // the per-call line would otherwise vanish without a word.
    const errored = err.mock.calls.flat().join(" ");
    expect(errored).toContain("FAILED to log");
    expect(errored).toContain(UNPRICED);
    // And the run-level table still came out, because the two are independent.
    expect(log.mock.calls.flat().join("\n")).toContain("TOTAL");
    void warn;
  });

  it("C2b: report()'s own diagnostic fires when the summary itself cannot be printed", () => {
    // report()'s console.error is a different path from add()'s and needs its
    // own exercise. Nothing in a normal run reaches it now that pricing
    // failures are caught per group, so force the failure it exists for: the
    // output channel itself breaking mid-report.
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const collector = createUsageCollector(AT);
    collector.add({ stage: "triage", model: "claude-haiku-4-5", tokens: t });
    expect(() => collector.report({ label: "digest complete" })).not.toThrow();

    const errored = err.mock.calls.flat().join(" ");
    expect(errored).toContain("FAILED to report usage");
    expect(errored).toContain("digest complete");
    void log;
  });

  it("C3: report() no longer goes silent, and the run's per-call lines survive", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const collector = createUsageCollector(AT);
    collector.add({ stage: "triage", model: "claude-haiku-4-5", tokens: t });
    collector.add({ stage: "writeCard", model: UNPRICED, tokens: t });
    collector.report({ label: "digest complete" });

    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain("triage claude-haiku-4-5");
    expect(printed).toContain("TOTAL");
  });

  it("C4: the digest route's finally-block shape cannot be stranded by report()", () => {
    // Mirrors route.ts: report() inside finally, after the mutex release path.
    const collector = createUsageCollector(AT);
    collector.add({ stage: "writeCard", model: UNPRICED, tokens: t });
    vi.spyOn(console, "log").mockImplementation(() => {});
    let released = false;
    expect(() => {
      try {
        /* pipeline body */
      } finally {
        collector.report({ label: "digest complete" });
        released = true;
      }
    }).not.toThrow();
    expect(released).toBe(true);
  });

  it("C5: formatCallLine's swallowed throw does not drop the call from the totals", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const collector = createUsageCollector(AT);
    collector.add({ stage: "writeCard", model: UNPRICED, tokens: t });
    // The record survived even though its log line could not be priced...
    expect(collector.calls()).toHaveLength(1);
    // ...but nothing about that call reached the console.
    expect(log.mock.calls.flat().join("\n")).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * D. Footer / tripwire claims.
 * ------------------------------------------------------------------ */
describe("D. footer claims", () => {
  const someCalls = [call("triage", "claude-haiku-4-5", tk({ inputTokens: 1000, outputTokens: 1000 }))];

  it("D1: the verification date prints for a run with calls", () => {
    const text = formatUsageSummary(summarizeUsage(someCalls, AT), { label: "x" }).join("\n");
    expect(text).toContain(`Rates last verified against published pricing ${PRICING_VERIFIED_ON}`);
  });

  it("D2: it is correctly ABSENT from both zero-call early returns", () => {
    const quiet = formatUsageSummary(summarizeUsage([], AT), { label: "x" }).join("\n");
    const warned = formatUsageSummary(summarizeUsage([], AT), { label: "x", expectedCalls: { triage: 3 } }).join("\n");
    expect(quiet).not.toContain("Rates last verified");
    expect(warned).not.toContain("Rates last verified");
  });

  it("D3: a floor-warning run still carries the verification date", () => {
    const withUnmeasured = [...someCalls, { stage: "writeCard" as const, model: "claude-sonnet-5" as const, tokens: null }];
    const text = formatUsageSummary(summarizeUsage(withUnmeasured, AT), { label: "x" }).join("\n");
    expect(text).toContain("FLOOR");
    expect(text).toContain("Rates last verified");
  });

  it("D4: the no-promo footer's claim matches the arithmetic it sits under", () => {
    const summary = summarizeUsage(someCalls, AT);
    const text = formatUsageSummary(summary, { label: "x" }).join("\n");
    expect(text).toContain("No promotional pricing is live for any model in this run; billed is list price");
    expect(summary.totalBilledUsd).toBe(summary.totalListUsd);
  });

  it("D5: PRICING_VERIFIED_ON is a real calendar date, not merely digit-shaped", () => {
    // The existing test only regex-checks the shape, so "2026-99-99" passes it.
    const d = new Date(`${PRICING_VERIFIED_ON}T00:00:00Z`);
    expect(Number.isFinite(d.getTime())).toBe(true);
    expect(d.toISOString().slice(0, 10)).toBe(PRICING_VERIFIED_ON);
  });

  it("D6: formatUsd never renders a nonzero cost as free", () => {
    expect(formatUsd(0.0000001)).toBe("<$0.000001");
    expect(formatUsd(0)).toBe("$0.000000");
  });

  it("D7: the staleness tripwire's own date is not in the future", () => {
    // A tripwire whose value is never checked is not a tripwire. Mutating
    // PRICING_VERIFIED_ON to "2062-09-11" survives the entire existing suite.
    expect(PRICING_VERIFIED_ON <= new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it("D8: a live promo on a stage that recorded no measurable tokens", () => {
    // No malformed table needed for the costFor/summarizeUsage disagreement:
    // a stage whose every call reported null usage aggregates to zero tokens,
    // so billedUsd < listUsd is false and costFor reports promoApplied=false
    // while the run-level notice says the promo applied.
    const table = promoTable({ rate: CHEAP });
    const unmeasured: RecordedCall[] = [{ stage: "writeCard", model: "claude-sonnet-5", tokens: null }];
    const summary = summarizeUsage(unmeasured, AT, table);
    // Do NOT write this as `applied === stages[0].cost.promoApplied`: that
    // pins a regression as correct, because with zero measurable tokens
    // promoApplied is false and the footer would claim a live promo was not in
    // effect. `applied` tracks the window; `discounted` tracks the saving.
    expect(summary.promos[0].applied).toBe(summary.stages[0].cost.promoLive);
    expect(summary.promos[0].discounted).toBe(summary.stages[0].cost.promoApplied);
    expect(summary.promos[0].applied).toBe(true);
    expect(summary.promos[0].discounted).toBe(false);

    // ASSERT THE RENDERED STRING, not just the flags. Checking only the
    // booleans here lets through a footer that tells the reader a 33%-cheaper
    // promo was "NOT cheaper than list" — flags right, sentence
    // built from them false. A cost report is read as prose, so the prose
    // is what has to be pinned.
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(text).not.toContain("NOT cheaper than list");
    expect(text).not.toContain("is not in effect for this run");
    // What it must say instead: in effect, but nothing measured to judge it by.
    expect(text).toContain("is in effect for this run");
    expect(text).toContain("cannot be said either way");
  });
});

/* ------------------------------------------------------------------ *
 * E. A model that carries a promo AND cannot be priced.
 *
 * This region is easy to leave unreached: seven killable mutants cluster in
 * it, including the footer's not-live-and-not-confirmably-at-list branch, which
 * no ordinary test enters. It is also where a real bug hides — reading
 * `applied` off the per-group costs, when an unpriceable group keeps a zero
 * seed whose promoLive is false, announces a live promo on a malformed entry
 * as "not in effect for this run".
 *
 * Latent rather than live today — it needs a promo, and PRICING has none —
 * which is exactly why it needs pinning now. It arms itself the day the next
 * introductory rate is added, and nothing else here would catch it.
 * ------------------------------------------------------------------ */
describe("E. a promoted model that cannot be priced", () => {
  const t = tk({ inputTokens: 1000, outputTokens: 1000 });

  /** A table whose promoted model has a structurally broken `list`. */
  function brokenPromoted(window: { fromUtcDate: string; throughUtcDate: string }) {
    return {
      "claude-haiku-4-5": PRICING["claude-haiku-4-5"],
      "claude-sonnet-5": {
        list: null,
        promo: { rate: CHEAP, ...window },
      },
    } as unknown as Record<TrackedModel, ModelPricing>;
  }

  const LIVE = { fromUtcDate: "2026-01-01", throughUtcDate: "2026-12-31" };
  const LAPSED = { fromUtcDate: "2026-01-01", throughUtcDate: "2026-02-01" };

  it("E1: a LIVE promo is still reported as in effect when the model cannot be priced", () => {
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, brokenPromoted(LIVE));
    // Whether a promotional window is open is a property of the rate card and
    // the clock. It stays knowable when the spend does not.
    expect(summary.promos[0].applied).toBe(true);
    expect(summary.stages[0].priced).toBe(false);

    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(text).not.toContain("is not in effect for this run");
    expect(text).toContain("could not price");
  });

  it("E2: an unpriceable stage is never called 'billed at list'", () => {
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, brokenPromoted(LAPSED));
    // The zero seed makes billedUsd === listUsd trivially true; the `priced`
    // gate is the only thing stopping that being read as a list-price claim.
    expect(summary.promos[0].billedAtList).toBe(false);
    expect(formatUsageSummary(summary, { label: "digest complete" }).join("\n")).not.toContain(
      "billed is list price"
    );
  });

  it("E3: the not-live/not-confirmable footer branch says what it can support", () => {
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, brokenPromoted(LAPSED));
    expect(summary.promos[0].applied).toBe(false);
    expect(summary.promos[0].billedAtList).toBe(false);

    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    // This branch fires ONLY for an unpriced group (when the promo is
    // not live, billedUsd is literally assigned listUsd, so billedAtList can
    // only be false if the cost never got computed). Do not word it as
    // "treat the billed column as the figure of record" — that points
    // at the $0.000000 placeholder the FLOOR warning above calls UNKNOWN.
    expect(text).toContain("could not be established at all");
    expect(text).toContain("placeholders, not a bill");
    expect(text).not.toContain("figure of record");
  });

  it("E4: an unpriceable promoted model is not silently measurable", () => {
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, brokenPromoted(LIVE));
    // `measurable` gates every claim about whether the promo saved anything.
    // An unpriced group has no list figure to compare, so it must be false.
    expect(summary.promos[0].measurable).toBe(false);
    expect(summary.promos[0].discounted).toBe(false);
    expect(summary.unpricedModels).toEqual(["claude-sonnet-5"]);
  });
});

/* ------------------------------------------------------------------ *
 * F. An unusable priced instant.
 *
 * `applied: false` has two causes that mean opposite things — the window was
 * shut, or it could not be checked. The footer must not flatten them:
 * an Invalid Date rendering as "introductory pricing is not in effect for this
 * run", which asserts something about Anthropic's rate card that a run with a
 * broken clock is in no position to claim. `clockUsable` separates them.
 * ------------------------------------------------------------------ */
describe("F. an unusable priced instant", () => {
  const t = tk({ inputTokens: 1000, outputTokens: 1000 });

  it("F1: does not claim a promo was out of effect when it could not be checked", () => {
    const table = promoTable({ rate: CHEAP });
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], new Date(NaN), table);

    expect(summary.clockUsable).toBe(false);
    // Pricing falls back to list, which can overstate but never understate.
    expect(summary.totalBilledUsd).toBe(summary.totalListUsd);

    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(text).toContain("could not be evaluated");
    expect(text).toContain("this run's timestamp was unusable");
    expect(text).not.toContain("is not in effect for this run");
  });

  it("F2: a usable clock still gets the plain not-in-effect line", () => {
    // The guard must not swallow the ordinary lapsed-promo case.
    const table = promoTable({ rate: CHEAP, fromUtcDate: "2026-01-01", throughUtcDate: "2026-02-01" });
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, table);

    expect(summary.clockUsable).toBe(true);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(text).toContain("is not in effect for this run; billed is list price");
    expect(text).not.toContain("could not be evaluated");
  });
});

/* ------------------------------------------------------------------ *
 * G. Where unpriceable and unusable-clock overlap, plus the boundaries
 *    the footer never exercised.
 *
 * Every one of these was a surviving mutant. The footer has now stated
 * something false four separate times, and each fix moved the falsehood to a
 * state the tests did not reach — so these pin the states themselves rather
 * than the sentences that happen to occupy them today.
 * ------------------------------------------------------------------ */
describe("G. overlapping failure states and window boundaries", () => {
  const t = tk({ inputTokens: 1000, outputTokens: 1000 });
  const WINDOW = { fromUtcDate: "2026-01-01", throughUtcDate: "2026-12-31" };

  function broken() {
    return {
      "claude-haiku-4-5": PRICING["claude-haiku-4-5"],
      "claude-sonnet-5": { list: null, promo: { rate: CHEAP, ...WINDOW } },
    } as unknown as Record<TrackedModel, ModelPricing>;
  }

  it("G1: an unpriceable model under a bad clock never claims pricing fell back to list", () => {
    // The fourth false-footer bug. `clockUsable` was tested before
    // priceability, so this state printed "Pricing fell back to list, which
    // can overstate but never understate" — this module's headline guarantee,
    // in the one state where it is false, because costFor threw and the figure
    // is a placeholder. Priceability now gates every money claim.
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], new Date(NaN), broken());
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");

    expect(text).not.toContain("fell back");
    expect(text).not.toContain("overstate but never understate");
    // And it must not swing back to the round-4 falsehood either.
    expect(text).not.toContain("is not in effect for this run");
    expect(text).toContain("could not be established at all");
    expect(text).toContain("placeholders, not a bill");
  });

  it("G2: a promo's LAST day is still in effect as rendered by the footer", () => {
    // The suite exercised the window's opening boundary through the footer and
    // never its closing one, so a predicate shifted by a day went unnoticed
    // there. On the last day the promo is live and cheaper.
    const table = promoTable({ rate: CHEAP, fromUtcDate: "2026-01-01", throughUtcDate: "2026-09-11" });
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, table);

    expect(summary.promos[0].applied).toBe(true);
    expect(summary.promos[0].discounted).toBe(true);
    expect(summary.totalBilledUsd).toBeLessThan(summary.totalListUsd);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(text).toContain("was in effect for this run");
    expect(text).not.toContain("is not in effect");
  });

  it("G3: the day AFTER a promo ends is rendered as not in effect", () => {
    const table = promoTable({ rate: CHEAP, fromUtcDate: "2026-01-01", throughUtcDate: "2026-09-10" });
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, table);

    expect(summary.promos[0].applied).toBe(false);
    expect(summary.totalBilledUsd).toBe(summary.totalListUsd);
    expect(formatUsageSummary(summary, { label: "digest complete" }).join("\n")).toContain(
      "is not in effect for this run; billed is list price"
    );
  });

  it("G4: a promo that makes a run free is measurable, not 'nothing measured'", () => {
    // `measurable` reads listUsd, never billedUsd. A rate-0 promo drives billed
    // to zero while list stays positive — reading billedUsd would report a
    // 100%-saving run as having had nothing to measure.
    const FREE = { inputPerMTok: 0, outputPerMTok: 0, cacheReadMultiplier: 0, cacheWriteMultiplier: 0 };
    const summary = summarizeUsage(
      [call("writeCard", "claude-sonnet-5", t)],
      AT,
      promoTable({ rate: FREE })
    );
    expect(summary.totalBilledUsd).toBe(0);
    expect(summary.totalListUsd).toBeGreaterThan(0);
    expect(summary.promos[0].measurable).toBe(true);
    expect(summary.promos[0].discounted).toBe(true);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(text).not.toContain("nothing priceable was measured");
  });

  it("G5: the staleness line does not call a placeholder the list price", () => {
    // The unpriced branch of the closing line. With an unpriceable model there
    // is no promo notice at all, so this line is the only one left — and it
    // would otherwise tell the reader the $0.000000 standing in for an UNKNOWN
    // cost is the list price. That sentence has produced a false log before.
    const UNPRICEABLE = "claude-opus-9" as unknown as TrackedModel;
    const summary = summarizeUsage([call("writeCard", UNPRICEABLE, t)], AT);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");

    expect(summary.promos).toEqual([]);
    expect(text).toContain(`Rates last verified against published pricing ${PRICING_VERIFIED_ON}`);
    expect(text).not.toContain("billed is list price");
    expect(text).toContain("before reading any total as a list-price figure");
  });
});

/* ------------------------------------------------------------------ *
 * H. Window states that are shut for reasons other than "ended", and
 *    the fallback-to-list guarantee.
 *
 * Holes five and six. Both were sentences, not logic — which is the whole
 * lesson of this file: on a module whose output is a claim about money, a
 * true computation rendered by a false sentence is still a false report.
 * ------------------------------------------------------------------ */
describe("H. window reasons and the list-fallback claim", () => {
  const t = tk({ inputTokens: 1000, outputTokens: 1000 });

  it("H1: a promo that has not STARTED is never described as having ended", () => {
    // `applied: false` under a usable clock has two causes and only one is
    // "ended". This printed `is not in effect (ended 2027-12-31)` — naming a
    // date over a year in the future as the moment it stopped.
    const table = promoTable({ rate: CHEAP, fromUtcDate: "2027-01-01", throughUtcDate: "2027-12-31" });
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, table);

    expect(summary.promos[0].windowState).toBe("notYetOpen");
    expect(summary.promos[0].applied).toBe(false);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");
    expect(text).not.toContain("ended 2027-12-31");
  });

  it("H2: the same distinction survives when the model is also unpriceable", () => {
    // The state that actually rendered the false string: branch 1, whose
    // window arm inferred "ended" from `applied === false`.
    const broken = {
      "claude-haiku-4-5": PRICING["claude-haiku-4-5"],
      "claude-sonnet-5": {
        list: null,
        promo: { rate: CHEAP, fromUtcDate: "2027-01-01", throughUtcDate: "2027-12-31" },
      },
    } as unknown as Record<TrackedModel, ModelPricing>;
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], AT, broken);
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");

    expect(summary.promos[0].windowState).toBe("notYetOpen");
    expect(text).toContain("has not opened yet");
    expect(text).not.toContain("ended");
  });

  it("H3: an unusable clock does not promise list pricing can only overstate", () => {
    // "Pricing fell back to list, which can overstate but never understate" is
    // true only if the promo is no dearer than list — an assumption this
    // module refuses everywhere else, which is why a surcharge branch exists.
    // With a DEARER promo, list is BELOW the real bill.
    const summary = summarizeUsage(
      [call("writeCard", "claude-sonnet-5", t)],
      new Date(NaN),
      promoTable({ rate: DEARER })
    );
    const text = formatUsageSummary(summary, { label: "digest complete" }).join("\n");

    expect(summary.clockUsable).toBe(false);
    expect(text).not.toContain("overstate but never understate");
    expect(text).toContain("these figures are not the bill");
  });

  it("H4: every window state is rendered by a distinct, applicable sentence", () => {
    // Guards the partition itself rather than any one sentence. Four states,
    // four renderings, no two the same and none empty.
    const cases: Array<[string, ReturnType<typeof promoTable>, Date]> = [
      ["open", promoTable({ rate: CHEAP }), AT],
      ["ended", promoTable({ rate: CHEAP, throughUtcDate: "2026-02-01" }), AT],
      ["notYetOpen", promoTable({ rate: CHEAP, fromUtcDate: "2027-01-01" }), AT],
      ["unknown", promoTable({ rate: CHEAP }), new Date(NaN)],
    ];
    const rendered = new Set<string>();
    for (const [expected, table, at] of cases) {
      const summary = summarizeUsage([call("writeCard", "claude-sonnet-5", t)], at, table);
      expect(summary.promos[0].windowState).toBe(expected);
      // The FOOTER line, not the per-stage table row — the row also contains
      // the model name, and three of the four states price identically at
      // list, so matching on the name alone silently compared table rows.
      const line = formatUsageSummary(summary, { label: "digest complete" }).find(
        (l) => l.includes("claude-sonnet-5") && /introductory|promotional/.test(l)
      );
      expect(line).toBeDefined();
      rendered.add(line as string);
    }
    expect(rendered.size).toBe(4);
  });
});
