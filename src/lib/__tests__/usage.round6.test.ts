/** Killing tests for promo-footer mutants that survive an ordinary sweep. */
import { describe, expect, it } from "vitest";
import {
  PRICING, costFor, formatUsageSummary, formatUsd, summarizeUsage,
  type CallTokens, type ModelPricing, type RecordedCall, type TrackedModel,
} from "@/lib/usage";

const AT = new Date("2026-09-11T12:00:00Z");
const BAD_CLOCK = new Date(NaN);
const tk = (p: Partial<CallTokens> = {}): CallTokens => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...p });
const R = (c: number) => ({ inputPerMTok: c, outputPerMTok: c * 5, cacheReadMultiplier: 0.1, cacheWriteMultiplier: 1.25 });
const calls: RecordedCall[] = [{ stage: "writeCard", model: "claude-sonnet-5", tokens: tk({ inputTokens: 1_000_000 }) }];
// sonnet: promo present, list MISSING -> costFor throws -> priced:false, notice still emitted
const unpriceableWithPromo = (from: string, through: string) => ({
  "claude-haiku-4-5": PRICING["claude-haiku-4-5"],
  "claude-sonnet-5": { promo: { rate: R(2), fromUtcDate: from, throughUtcDate: through } } as unknown as ModelPricing,
}) as Record<TrackedModel, ModelPricing>;

describe("G1: promoLive is false for a model that has no promo at all", () => {
  it("costFor must not claim a promotional window was confirmed open for Haiku", () => {
    expect(costFor("claude-haiku-4-5", tk({ inputTokens: 1000 }), AT).promoLive).toBe(false);
    expect(costFor("claude-haiku-4-5", tk({ inputTokens: 1000 }), AT).promoEndsOn).toBeNull();
  });
});

describe("G2: an UNPRICED group's zero seed must not claim a live promo", () => {
  it("the seed costs left behind by a throwing costFor report promoLive=false", () => {
    const s = summarizeUsage(calls, AT, unpriceableWithPromo("2026-01-01", "2026-12-31"));
    const g = s.stages.find((x) => x.model === "claude-sonnet-5")!;
    expect(g.priced).toBe(false);
    expect(g.cost.promoLive).toBe(false);
    expect(g.cost.promoApplied).toBe(false);
  });
});

describe("G3: the smallest renderable cost is shown exactly, not as '<'", () => {
  it("formatUsd at exactly SMALLEST_SHOWN_USD renders the number", () => {
    expect(formatUsd(0.000001)).toBe("$0.000001");
    expect(formatUsd(0.0000009)).toBe("<$0.000001");
  });
});

describe("G4: a stage with no unmeasured calls renders a bare count", () => {
  it("does not render '1+0?' when nothing went unmeasured", () => {
    const s = summarizeUsage(calls, AT);
    const lines = formatUsageSummary(s, { label: "digest complete" });
    const rowLine = lines.find((l) => l.includes("writeCard"))!;
    expect(rowLine).not.toContain("+0?");
    expect(rowLine).toMatch(/writeCard\s+1\s+claude-sonnet-5/);
  });
});

describe("G5: the unpriceable-model footer reports the WINDOW state correctly", () => {
  it("unusable clock -> says the timestamp was unusable, not a window verdict", () => {
    const s = summarizeUsage(calls, BAD_CLOCK, unpriceableWithPromo("2026-01-01", "2026-12-31"));
    const line = formatUsageSummary(s, { label: "digest complete" }).find((l) => l.includes("promotional window"))!;
    expect(line).toContain("could not be evaluated (this run's timestamp was unusable)");
    expect(line).not.toContain("is in effect");
  });
  it("usable clock + open window -> says the window IS in effect", () => {
    const s = summarizeUsage(calls, AT, unpriceableWithPromo("2026-01-01", "2026-12-31"));
    const line = formatUsageSummary(s, { label: "digest complete" }).find((l) => l.includes("promotional window"))!;
    expect(line).toContain("is in effect (through 2026-12-31)");
    expect(line).not.toContain("could not be evaluated");
  });
});

/* ---- G-U: the three REACHABLE promo states no test in the repo reached ----
   Enumerated mechanically in zz-round6-statespace.test.ts: 11 of the 64 flag
   combinations are reachable, the committed suite covered 8. These are the
   other three. */
const pricedPromo = (rate: number, from: string, through: string) => ({
  "claude-haiku-4-5": PRICING["claude-haiku-4-5"],
  "claude-sonnet-5": { list: R(3), promo: { rate: R(rate), fromUtcDate: from, throughUtcDate: through } },
}) as Record<TrackedModel, ModelPricing>;
const zeroTokenCall: RecordedCall[] = [{ stage: "writeCard", model: "claude-sonnet-5", tokens: tk() }];

describe("G-U1: priced, clock UNUSABLE, nothing measurable", () => {
  it("still warns about the unevaluable window and does not claim a discount", () => {
    const s = summarizeUsage(zeroTokenCall, BAD_CLOCK, pricedPromo(2, "2026-01-01", "2026-12-31"));
    const p = s.promos[0];
    expect([p.priced, s.clockUsable, p.applied, p.measurable, p.discounted, p.billedAtList])
      .toEqual([true, false, false, false, false, true]);
    const line = formatUsageSummary(s, { label: "digest complete" }).find((l) => l.includes("promotional window"))!;
    expect(line).toContain("could not be evaluated");
    expect(line).toContain("it was priced at ");
    expect(line).toContain("higher if the rate was a discount");
  });
});

describe("G-U2: priced, clock fine, window LAPSED, nothing measurable", () => {
  it("reports the promo as not in effect and billed as list", () => {
    const s = summarizeUsage(zeroTokenCall, AT, pricedPromo(2, "2025-01-01", "2025-12-31"));
    const p = s.promos[0];
    expect([p.priced, s.clockUsable, p.applied, p.measurable, p.discounted, p.billedAtList])
      .toEqual([true, true, false, false, false, true]);
    const line = formatUsageSummary(s, { label: "digest complete" }).find((l) => l.includes("introductory pricing"))!;
    expect(line).toContain("is not in effect for this run; billed is list price");
  });
});

describe("G-U3: a LIVE promo priced EXACTLY EQUAL to list", () => {
  it("is reported as not cheaper, and billedAtList stays true", () => {
    const s = summarizeUsage(calls, AT, pricedPromo(3, "2026-01-01", "2026-12-31"));
    const p = s.promos[0];
    expect([p.priced, s.clockUsable, p.applied, p.measurable, p.discounted, p.billedAtList])
      .toEqual([true, true, true, true, false, true]);
    expect(s.totalBilledUsd).toBe(s.totalListUsd);
    const line = formatUsageSummary(s, { label: "digest complete" }).find((l) => l.includes("NOT cheaper than list"))!;
    expect(line).toBeDefined();
    // It is genuinely not cheaper — but it is also not a surcharge, and the
    // footer must not imply the run was overcharged.
    expect(line).toContain("compare it against");
  });
});

describe("G-U4: priced, clock fine, window NOT YET OPEN, nothing measurable", () => {
  it("says the rate has not opened yet rather than quoting an end date", () => {
    const s = summarizeUsage(zeroTokenCall, AT, pricedPromo(2, "2027-01-01", "2027-12-31"));
    const p = s.promos[0];
    expect([p.priced, s.clockUsable, p.windowState, p.applied, p.measurable, p.discounted, p.billedAtList])
      .toEqual([true, true, "notYetOpen", false, false, false, true]);
    const line = formatUsageSummary(s, { label: "digest complete" }).find((l) => l.includes("introductory rate"))!;
    expect(line).toContain("has not opened yet (window ends 2027-12-31)");
    expect(line).toContain("billed is list price");
  });
});
