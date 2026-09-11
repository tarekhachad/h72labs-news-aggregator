/**
 * ROUND 6 — exhaustive reachable-state enumeration for the promo footer.
 *
 * Not scaffolding-by-example: this sweeps a cross product of genuine inputs
 * through summarizeUsage, records every (priced, clockUsable, applied,
 * measurable, discounted, billedAtList) tuple it can actually produce, renders
 * the footer for each, and checks every clause of the emitted sentence against
 * ground truth computed by an INDEPENDENT re-implementation of the pricing
 * arithmetic in this file. The checker never reads a PromoNotice flag to
 * decide what is true — that is the whole point, since four previous false
 * footers were all "the sentence agreed with the flag, and the flag was wrong".
 */
import { describe, expect, it } from "vitest";
import {
  PRICING,
  formatUsageSummary,
  summarizeUsage,
  type CallTokens,
  type ModelPricing,
  type Rate,
  type RecordedCall,
  type TrackedModel,
  type UsageStage,
} from "@/lib/usage";

const M: TrackedModel = "claude-sonnet-5";
const AT_VALID = new Date("2026-09-11T12:00:00Z");
const AT_INVALID = new Date(NaN);
const TODAY = "2026-09-11";

const R = (c: number): Rate => ({
  inputPerMTok: c,
  outputPerMTok: c * 5,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
});

/** INDEPENDENT re-implementation of applyRate. Do not import the real one. */
function priceIndependently(t: CallTokens, rate: Rate): number {
  const input =
    t.inputTokens * rate.inputPerMTok +
    t.cacheWriteTokens * rate.inputPerMTok * rate.cacheWriteMultiplier +
    t.cacheReadTokens * rate.inputPerMTok * rate.cacheReadMultiplier;
  return (input + t.outputTokens * rate.outputPerMTok) / 1_000_000;
}

const TOKENS = {
  nonzero: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  zero: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
} as const;

type TokenKind = "nonzero" | "zero" | "null";
type ListKind = "normal" | "missing" | "zerorate";
type PromoKind = "cheaper" | "equal" | "dearer" | "zerorate" | "absent";
type WindowKind = "current" | "past" | "future";
type ClockKind = "valid" | "invalid";

const LIST_RATES: Record<Exclude<ListKind, "missing">, Rate> = { normal: R(3), zerorate: R(0) };
const PROMO_RATES: Record<Exclude<PromoKind, "absent">, Rate> = {
  cheaper: R(2), equal: R(3), dearer: R(9), zerorate: R(0),
};
const WINDOWS: Record<WindowKind, { fromUtcDate: string; throughUtcDate: string }> = {
  current: { fromUtcDate: "2026-01-01", throughUtcDate: "2026-12-31" },
  past: { fromUtcDate: "2025-01-01", throughUtcDate: "2025-12-31" },
  future: { fromUtcDate: "2027-01-01", throughUtcDate: "2027-12-31" },
};

const GROUP_SHAPES: TokenKind[][] = [
  ["nonzero"], ["zero"], ["null"],
  ["nonzero", "zero"], ["nonzero", "null"], ["zero", "null"],
  ["nonzero", "nonzero"], ["zero", "zero"], ["null", "null"],
];
const STAGES: UsageStage[] = ["writeCard", "expand", "triage"];

interface Fixture {
  id: string;
  list: ListKind; promo: PromoKind; window: WindowKind; clock: ClockKind; shape: TokenKind[];
  table: Record<TrackedModel, ModelPricing>;
  at: Date;
  calls: RecordedCall[];
}

function buildFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const list of ["normal", "missing"] as ListKind[])
    for (const promo of ["cheaper", "equal", "dearer", "zerorate", "absent"] as PromoKind[])
      for (const window of ["current", "past", "future"] as WindowKind[])
        for (const clock of ["valid", "invalid"] as ClockKind[])
          for (const shape of GROUP_SHAPES) {
            if (promo === "absent" && window !== "current") continue; // window irrelevant
            const entry: Record<string, unknown> = {};
            if (list !== "missing") entry.list = LIST_RATES[list];
            if (promo !== "absent") entry.promo = { rate: PROMO_RATES[promo], ...WINDOWS[window] };
            const table = {
              "claude-haiku-4-5": PRICING["claude-haiku-4-5"],
              [M]: entry as unknown as ModelPricing,
            } as Record<TrackedModel, ModelPricing>;
            const calls: RecordedCall[] = shape.map((k, i) => ({
              stage: STAGES[i % STAGES.length], model: M,
              tokens: k === "null" ? null : { ...TOKENS[k] },
            }));
            out.push({
              id: `list=${list} promo=${promo} win=${window} clock=${clock} shape=[${shape.join("+")}]`,
              list, promo, window, clock, shape, table, at: clock === "valid" ? AT_VALID : AT_INVALID, calls,
            });
          }
  return out;
}

/** Ground truth for a fixture, derived from the fixture alone. */
function groundTruth(f: Fixture) {
  const clockUsable = f.clock === "valid";
  const w = f.promo === "absent" ? null : WINDOWS[f.window];
  const windowOpen = clockUsable && w !== null && TODAY >= w.fromUtcDate && TODAY <= w.throughUtcDate;
  const windowEnded = clockUsable && w !== null && TODAY > w.throughUtcDate;
  const windowNotStarted = clockUsable && w !== null && TODAY < w.fromUtcDate;
  const priced = f.list !== "missing";

  // Per-group independently computed list/billed, grouped by (stage, model).
  const byStage = new Map<UsageStage, CallTokens>();
  for (const c of f.calls) {
    const cur = byStage.get(c.stage) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    if (c.tokens) {
      cur.inputTokens += c.tokens.inputTokens; cur.outputTokens += c.tokens.outputTokens;
      cur.cacheReadTokens += c.tokens.cacheReadTokens; cur.cacheWriteTokens += c.tokens.cacheWriteTokens;
    }
    byStage.set(c.stage, cur);
  }
  const groups = [...byStage.values()].map((t) => {
    if (!priced) return { listUsd: null as number | null, billedUsd: null as number | null, promoUsd: null as number | null };
    const listUsd = priceIndependently(t, LIST_RATES[f.list as "normal" | "zerorate"]);
    const promoUsd = f.promo === "absent" ? null : priceIndependently(t, PROMO_RATES[f.promo]);
    const billedUsd = windowOpen && promoUsd !== null ? promoUsd : listUsd;
    return { listUsd, billedUsd, promoUsd };
  });

  const windowState = f.promo === "absent" ? null
    : !clockUsable ? "unknown" : windowOpen ? "open" : windowNotStarted ? "notYetOpen" : "ended";
  return {
    windowState,
    clockUsable, windowOpen, windowEnded, windowNotStarted, priced, groups,
    endsOn: w?.throughUtcDate ?? null,
    anyCheaper: priced && groups.some((g) => g.billedUsd! < g.listUsd!),
    allBilledAtList: priced && groups.every((g) => g.billedUsd === g.listUsd),
    anyListPositive: priced && groups.some((g) => g.listUsd! > 0),
    // Would a fallback-to-list understate? Only if the promo rate is dearer
    // than list for tokens that actually exist.
    fallbackWouldUnderstate: priced && groups.some((g) => g.promoUsd !== null && g.promoUsd > g.listUsd!),
  };
}

const PROMO_LINE = /promotional|introductory/;

interface Violation { fixture: string; line: string; clause: string }

function checkFooterClauses(f: Fixture, line: string, gt: ReturnType<typeof groundTruth>): Violation[] {
  const v: Violation[] = [];
  const bad = (clause: string) => v.push({ fixture: f.id, line, clause });

  if (line.includes("its cost could not be established at all")) {
    // BRANCH A — unpriceable model that still has a promo entry.
    if (gt.priced) bad("claims cost could not be established, but the model priced fine");
    if (line.includes("could not be evaluated (this run's timestamp was unusable)") && gt.windowState !== "unknown")
      bad("claims the timestamp was unusable, but the clock was usable");
    if (line.includes("is in effect (through") && gt.windowState !== "open")
      bad("claims the window is in effect, but it is not open");
    if (line.includes("has not opened yet") && gt.windowState !== "notYetOpen")
      bad("claims the window has not opened yet, but it has");
    if (line.includes("is not in effect (ended") && gt.windowState !== "ended")
      bad(`claims the window "ended", but it has not (state=${gt.windowState})`);
  } else if (line.includes("it was priced at ") || line.includes("Pricing fell back to list")) {
    // BRANCH B — priced, clock unusable.
    if (!gt.priced) bad("asserts a list-price fallback figure for a model that could not be priced");
    if (gt.clockUsable) bad("claims the timestamp was unusable, but the clock was usable");
    if (!gt.allBilledAtList) bad("claims it was priced at list, but some group was not billed at list");
    if (line.includes("never understate") && gt.fallbackWouldUnderstate)
      bad("guarantees the fallback can 'never understate', but this model's promo rate is DEARER than list");
    // the hedged replacement must name BOTH directions, not guarantee one
    if (line.includes("these figures are not the bill")) {
      if (!line.includes("higher if the rate was a discount") || !line.includes("lower if it was a surcharge"))
        bad("hedge names only one direction of error");
    }
  } else if (line.includes("has not opened yet (window ends")) {
    // BRANCH F-a — priced, clock fine, window not yet open.
    if (!gt.priced) bad("branch assumes priced");
    if (gt.windowState !== "notYetOpen") bad(`claims the window has not opened yet, but state=${gt.windowState}`);
    if (!gt.allBilledAtList) bad("claims billed is list price, but a group was not billed at list");
  } else if (line.includes("nothing priceable was measured")) {
    // BRANCH C
    if (!gt.priced) bad("branch assumes priced");
    if (!gt.windowOpen) bad("claims introductory pricing is in effect, but the window is not open");
    if (gt.anyListPositive) bad("claims nothing priceable was measured, but a group has listUsd > 0");
  } else if (line.includes("was in effect for this run and ends")) {
    // BRANCH D
    if (!gt.priced) bad("branch assumes priced");
    if (!gt.windowOpen) bad("claims the promo was in effect, but the window is not open");
    if (!gt.anyCheaper) bad("implies a discount ('at list is what this run costs from the day after'), but nothing was cheaper");
  } else if (line.includes("NOT cheaper than list")) {
    // BRANCH E
    if (!gt.priced) bad("branch assumes priced");
    if (!gt.windowOpen) bad("claims a promotional rate is in effect, but the window is not open");
    if (gt.anyCheaper) bad("claims NOT cheaper than list, but a group was billed below list");
  } else if (line.includes("is not \nin effect") || line.includes("is not in effect for this run; billed is list price")) {
    // BRANCH F
    if (!gt.priced) bad("branch assumes priced");
    if (gt.windowState !== "ended") bad(`claims 'introductory pricing (through X) is not in effect' but state=${gt.windowState} — 'through X' reads as an end date`);
    if (!gt.allBilledAtList) bad("claims billed is list price, but a group was not billed at list");
  } else if (PROMO_LINE.test(line)) {
    bad("UNCLASSIFIED promo line — the branch enumeration in this harness is incomplete");
  }
  return v;
}

const fixtures = buildFixtures();

describe("ROUND 6: exhaustive reachable state space of the promo footer", () => {
  const reachable = new Map<string, { fixture: string; line: string }>();
  const violations: Violation[] = [];

  for (const f of fixtures) {
    const summary = summarizeUsage(f.calls, f.at, f.table);
    const gt = groundTruth(f);
    const lines = formatUsageSummary(summary, { label: "digest complete" });
    // Only the promo lines for our model M; join wrapped text back to one line.
    const promoLines = lines.filter((l) => PROMO_LINE.test(l) && l.includes(M));
    for (const notice of summary.promos.filter((p) => p.model === M)) {
      if (notice.applied !== (notice.windowState === "open"))
        violations.push({ fixture: f.id, line: "(flags)", clause: `applied (${notice.applied}) disagrees with windowState (${notice.windowState})` });
      if (notice.windowState !== gt.windowState)
        violations.push({ fixture: f.id, line: "(flags)", clause: `windowState (${notice.windowState}) disagrees with ground truth (${gt.windowState})` });
      const key = [
        `priced=${+notice.priced}`, `clock=${+summary.clockUsable}`, `win=${notice.windowState}`, `applied=${+notice.applied}`,
        `measurable=${+notice.measurable}`, `discounted=${+notice.discounted}`, `billedAtList=${+notice.billedAtList}`,
      ].join(" ");
      if (!reachable.has(key)) reachable.set(key, { fixture: f.id, line: promoLines.join(" | ") });
    }
    for (const l of promoLines) violations.push(...checkFooterClauses(f, l, gt));
  }

  it("enumerates the reachable tuples and reports them", () => {
    const report = [...reachable.entries()].sort().map(([k, v]) => `${k}\n    via: ${v.fixture}`);
    console.log(`\n=== REACHABLE TUPLES (${reachable.size}) ===\n${report.join("\n")}\n`);
    expect(reachable.size).toBeGreaterThan(0);
  });

  it("every clause of every rendered footer sentence is true of its state", () => {
    if (violations.length > 0) {
      const grouped = new Map<string, string[]>();
      for (const v of violations) {
        const arr = grouped.get(v.clause) ?? [];
        arr.push(v.fixture);
        grouped.set(v.clause, arr);
      }
      const msg = [...grouped.entries()]
        .map(([clause, fx]) => `\nCLAUSE VIOLATION: ${clause}\n  ${fx.length} fixture(s), e.g.:\n    ${fx.slice(0, 4).join("\n    ")}`)
        .join("\n");
      console.log(`\n=== FALSE CLAUSES ===${msg}\n`);
    }
    expect(violations.map((v) => `${v.clause} :: ${v.fixture}`)).toEqual([]);
  });
});
