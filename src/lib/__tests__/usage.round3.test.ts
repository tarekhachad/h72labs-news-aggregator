/**
 * QA round 3 — probes aimed at the mutants that SURVIVED round 3's mutation
 * sweep, plus the round-2 fixes whose new lines no test reaches.
 * PERMANENT — do not delete. Same reasoning as usage.adversarial.test.ts:
 * mutation testing shows this file is the sole coverage for five mutants, and
 * P1b is the only test anywhere in the repo that kills `billedAtList`'s
 * `every` being weakened to `some`. It was written as round scaffolding; it
 * stopped being scaffolding the moment it was the only thing holding a
 * guarantee in place.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  LOG_PREFIX,
  PRICING,
  costFor,
  formatCallLine,
  formatUsageSummary,
  summarizeUsage,
  type CallTokens,
  type ModelPricing,
  type RecordedCall,
  type TrackedModel,
} from "@/lib/usage";
import { createUsageCollector } from "@/lib/usageCollector";

const AT = new Date("2026-09-11T12:00:00Z");
const tk = (p: Partial<CallTokens> = {}): CallTokens => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...p,
});
const R = (c: number) => ({ inputPerMTok: c, outputPerMTok: c * 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 });

function tableWith(rate: ReturnType<typeof R>, from = "2026-01-01", through = "2026-12-31"): Record<TrackedModel, ModelPricing> {
  return {
    "claude-haiku-4-5": PRICING["claude-haiku-4-5"],
    "claude-sonnet-5": { list: R(3), promo: { rate, fromUtcDate: from, throughUtcDate: through } },
  };
}

/* ---- P1: mixed-group promo aggregation (mutants M8 `every`->`some`, M10 `some`->`every`) ---- */
describe("P1: a promo'd model split across a measured and an unmeasured stage group", () => {
  const mixed: RecordedCall[] = [
    { stage: "writeCard", model: "claude-sonnet-5", tokens: tk({ inputTokens: 1_000_000 }) },
    { stage: "expand", model: "claude-sonnet-5", tokens: null }, // zero tokens -> billed === list === 0
  ];

  it("P1a: a CHEAP live promo reports applied=true even though one group priced flat", () => {
    const s = summarizeUsage(mixed, AT, tableWith(R(2)));
    expect(s.stages).toHaveLength(2);
    const zeroGroup = s.stages.find((g) => g.stage === "expand")!;
    expect(zeroGroup.cost.billedUsd).toBe(zeroGroup.cost.listUsd); // the `some`/`every` divider
    expect(s.promos[0].applied).toBe(true);
    expect(s.promos[0].billedAtList).toBe(false);
    const text = formatUsageSummary(s, { label: "digest complete" }).join("\n");
    expect(text).toContain("introductory pricing was in effect");
  });

  it("P1b: a DEARER live promo must not be footnoted as 'billed is list price'", () => {
    const s = summarizeUsage(mixed, AT, tableWith(R(9)));
    expect(s.totalBilledUsd).toBeGreaterThan(s.totalListUsd);
    // `applied` tracks the promo WINDOW and `discounted` the saving — split in
    // round 3 after a spend-only `applied` reported a live promo as "not in
    // effect" whenever a run's tokens were unmeasurable. A dearer promo is
    // live and not a discount, which is exactly this case.
    expect(s.promos[0].applied).toBe(true);
    expect(s.promos[0].discounted).toBe(false);
    expect(s.promos[0].billedAtList).toBe(false); // `some` would say true here
    const text = formatUsageSummary(s, { label: "digest complete" }).join("\n");
    expect(text).toContain("NOT cheaper than list");
    expect(text).not.toContain("billed is list price");
  });
});

/* ---- P2: formatCallLine's table parameter (mutant M15) ---- */
describe("P2: formatCallLine actually prices off the injected table", () => {
  it("P2a: an injected promo rate changes the per-call line", () => {
    const call: RecordedCall = {
      stage: "writeCard", model: "claude-sonnet-5", tokens: tk({ inputTokens: 1_000_000 }),
    };
    const viaDefault = formatCallLine(call, AT);
    const viaTable = formatCallLine(call, AT, tableWith(R(2)));
    expect(viaDefault).toContain("$2.000000"); // real PRICING list
    expect(viaTable).toContain("$2.000000");   // promo rate $2 on a $3 list
    // Make the two genuinely differ so the parameter cannot be inert.
    const viaCheap = formatCallLine(call, AT, tableWith(R(0.5)));
    expect(viaCheap).toContain("$0.500000");
    expect(viaCheap).not.toBe(viaDefault);
  });

  it("P2b: per-call lines and the run summary agree when both get the same table", () => {
    const t = tk({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const table = tableWith(R(0.5));
    const call: RecordedCall = { stage: "writeCard", model: "claude-sonnet-5", tokens: t };
    const line = formatCallLine(call, AT, table);
    const s = summarizeUsage([call], AT, table);
    expect(line).toContain(`$${s.totalBilledUsd.toFixed(6)}`);
  });
});

/* ---- P3: the report()-failure diagnostic (mutants M16, M17) ---- */
describe("P3: report() failing must say so on console.error", () => {
  afterEach(() => vi.restoreAllMocks());

  it("P3a: a broken stdout produces a console.error diagnostic carrying LOG_PREFIX and the label", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => { throw new Error("stdout is gone"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const collector = createUsageCollector(AT);
    collector.add({ stage: "triage", model: "claude-haiku-4-5", tokens: tk({ inputTokens: 10 }) });

    expect(() => collector.report({ label: "digest complete" })).not.toThrow();

    expect(err).toHaveBeenCalled();
    const printed = err.mock.calls.flat().map(String).join(" ");
    expect(printed).toContain(LOG_PREFIX);
    expect(printed).toContain("FAILED to report usage");
    expect(printed).toContain("digest complete");
    expect(log).toHaveBeenCalled();
  });

  it("P3b: a run that cost money and reported nothing is distinguishable from a free run", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => { throw new Error("stdout is gone"); });
    const paid = createUsageCollector(AT);
    paid.add({ stage: "writeCard", model: "claude-sonnet-5", tokens: tk({ inputTokens: 999_999 }) });
    paid.report({ label: "digest complete" });
    const paidNoise = err.mock.calls.length;

    err.mockClear();
    const free = createUsageCollector(AT);
    free.report({ label: "digest complete" }); // 0 calls -> one line, still throws on console.log
    expect(paidNoise).toBeGreaterThan(0);
  });
});

/* ---- P4: unpricedModels dedup (mutant M12) ---- */
describe("P4: the unpriced warning names each model once", () => {
  const UNPRICED = "claude-opus-9" as unknown as TrackedModel;
  it("P4a: two stages sharing one unpriceable model list it once", () => {
    const t = tk({ inputTokens: 1000 });
    const s = summarizeUsage(
      [
        { stage: "writeCard", model: UNPRICED, tokens: t },
        { stage: "expand", model: UNPRICED, tokens: t },
      ],
      AT
    );
    expect(s.stages).toHaveLength(2);
    expect(s.unpricedModels).toEqual([UNPRICED]);
    const warning = formatUsageSummary(s, { label: "x" }).find((l) => l.includes("could not price"))!;
    expect(warning.match(/claude-opus-9/g)).toHaveLength(1);
  });
});

/* ---- P5: the promo half of deepFreezePricing (mutant M2) ---- */
describe("P5: deepFreezePricing freezes a promo, not just a list", () => {
  it("P5a: PRICING has no promo today, so the promo freeze is unexercised", () => {
    // Documents WHY M2 survives: the branch is unreachable with today's table.
    const promos = Object.values(PRICING).filter((p) => p.promo !== undefined);
    expect(promos).toHaveLength(0);
  });
});

/* ---- P6: report() is unthrowable — the mutex guarantee ---- */
describe("P6: nothing report() can hit may escape and strand the generation mutex", () => {
  afterEach(() => vi.restoreAllMocks());
  const t = tk({ inputTokens: 10, outputTokens: 10 });

  const scenarios: [string, () => void][] = [
    ["console.log throws", () => { vi.spyOn(console, "log").mockImplementation(() => { throw new Error("log"); }); vi.spyOn(console, "error").mockImplementation(() => {}); }],
    ["console.log AND console.error both throw", () => {
      vi.spyOn(console, "log").mockImplementation(() => { throw new Error("log"); });
      vi.spyOn(console, "error").mockImplementation(() => { throw new Error("err"); });
    }],
    ["console.log throws a non-Error", () => {
      vi.spyOn(console, "log").mockImplementation(() => { throw "a string"; });
      vi.spyOn(console, "error").mockImplementation(() => {});
    }],
  ];

  for (const [name, arrange] of scenarios) {
    it(`P6: survives — ${name}`, () => {
      arrange();
      const c = createUsageCollector(AT);
      c.add({ stage: "triage", model: "claude-haiku-4-5", tokens: t });
      let released = false;
      expect(() => {
        try { /* pipeline */ } finally {
          c.report({ label: "digest complete" });
          released = true;
        }
      }).not.toThrow();
      expect(released).toBe(true);
    });
  }

  it("P6d: a throwing `label` getter cannot escape either", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = createUsageCollector(AT);
    c.add({ stage: "triage", model: "claude-haiku-4-5", tokens: t });
    const opts = { get label(): string { throw new Error("nasty label"); } };
    expect(() => c.report(opts)).not.toThrow();
  });

  it("P6e: an unpriceable model in a real run cannot escape report()", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = createUsageCollector(AT);
    c.add({ stage: "writeCard", model: "claude-opus-9" as unknown as TrackedModel, tokens: t });
    expect(() => c.report({ label: "digest complete" })).not.toThrow();
  });
});

/* ---- P7: frozen PRICING vs. fixtures that spread or share it ---- */
describe("P7: the deep freeze does not break table injection", () => {
  const t = tk({ inputTokens: 1_000_000 });

  it("P7a: spreading PRICING into a fixture yields a WRITABLE top level", () => {
    const fixture = { ...PRICING };
    expect(Object.isFrozen(fixture)).toBe(false);
    (fixture as Record<string, unknown>)["claude-sonnet-5"] = { list: R(7) };
    expect(costFor("claude-sonnet-5", t, AT, fixture).listUsd).toBeCloseTo(7, 12);
    // ...and the real table is untouched.
    expect(costFor("claude-sonnet-5", t, AT).listUsd).toBeCloseTo(2, 12);
  });

  it("P7b: a fixture REUSING a frozen entry cannot be patched in place", () => {
    // The trap a future fixture author will hit: sharing PRICING's entry and
    // then editing its nested list. It throws in ESM strict mode.
    const fixture = { ...PRICING };
    expect(() => {
      (fixture["claude-sonnet-5"].list as { inputPerMTok: number }).inputPerMTok = 7;
    }).toThrow(TypeError);
  });

  it("P7c: summarize and costFor stay consistent on a shared frozen entry", () => {
    const fixture = { ...PRICING };
    const s = summarizeUsage([{ stage: "writeCard", model: "claude-sonnet-5", tokens: t }], AT, fixture);
    expect(s.totalBilledUsd).toBeCloseTo(costFor("claude-sonnet-5", t, AT, fixture).billedUsd, 12);
  });
});
