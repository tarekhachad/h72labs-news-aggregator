/**
 * Turns the run log into a report that computes its own numbers.
 *
 * This is the "present" end of emit → store → present, and the reason the
 * other two exist. Until now every cost figure this project published was
 * read off terminal scrollback and retyped into markdown by hand, which made
 * averages and trends not merely tedious but uncomputable — no two runs were
 * ever recorded in the same place in the same shape. Worse, a hand-typed
 * figure carries no provenance, so when Sonnet's price turned out to be wrong
 * there was no way to tell which published numbers were affected without
 * re-deriving all of them.
 *
 * Pure, like `usage.ts` and `usageRecord.ts`: no filesystem, no clock, no
 * network. `scripts/cost-report.ts` is the thin I/O shell around it.
 *
 * **All arithmetic lives in `buildCostReport`.** The two renderers are layout
 * over the struct it returns and compute nothing — not a sum, not a
 * percentage, not a rounding. That split is what lets one test assert every
 * headline figure appears verbatim in both outputs, so the markdown and the
 * HTML cannot drift into disagreeing about the same run.
 *
 * ## The two rules that shape the type
 *
 * **1. Segmentation is structural.** There is deliberately NO all-runs mean
 * anywhere on `CostReport` — not private, not unused. Cold runs and warm runs
 * cost materially different amounts, and a blended mean describes no real
 * user while looking authoritative. Making the field nonexistent means a
 * renderer cannot print one by accident; if someone wants a blend they have
 * to add the field and justify it.
 *
 * **2. A floor run is not a sample.** `isFloor` means the row's dollar totals
 * are a lower bound — some spend is missing by an unknown amount. Averaging
 * one in drags a trend line down invisibly. They are counted and shown, never
 * averaged, and the exclusion count sits on the report's face rather than in
 * a footnote.
 */

// Relative, and the ONLY file in src/lib that is. `@/` is a bundler alias:
// Next resolves it, vitest resolves it, and plain `node` does not. This module
// is the one piece of the app that runs outside the bundler — `npm run
// cost-report` executes `scripts/cost-report.mts` directly on Node's native
// type stripping — so an aliased runtime import here fails at the shell with a
// module-not-found while type-checking perfectly.
//
// It stays a one-line exception rather than spreading: `usage.ts` imports
// nothing itself, so this is the entire runtime dependency chain. The second
// import below is type-only and therefore erased before Node ever sees it —
// if it ever becomes a value import, it has to become relative too.
import { formatUsd, SMALLEST_SHOWN_USD } from "./usage.ts";
import type { PublicUsageRunRecord, RunShape } from "@/lib/usageRecord";

/**
 * A statistic over the runs that actually carried a value.
 *
 * `n` is not decoration. Every run-shape field on a record is nullable
 * because a run can exit before learning it, so the denominator for
 * "cards per run" is genuinely different from the denominator for "dollars
 * per run" within the very same set of runs. Carrying `n` next to the mean
 * is what stops a reader assuming they share one.
 */
export interface SampleStat {
  /** How many runs contributed a value. Nulls are excluded, not counted as 0. */
  n: number;
  /** Null when nothing contributed — never 0, which would read as a measurement. */
  mean: number | null;
  min: number | null;
  max: number | null;
}

/**
 * One (route, run shape) group. Keyed by BOTH, not by shape alone: an expand
 * carries `runShape: "unknown"` because it has no cold/warm dimension at all,
 * and a digest carries it when the existing-cards fetch failed. Those are
 * different facts, and pooling them would put a single Sonnet call in the
 * same mean as a whole digest pipeline.
 */
export interface CostReportSection {
  route: "digest" | "expand";
  runShape: RunShape;
  totalRuns: number;
  /** Runs whose totals are a floor. Counted here, excluded from every stat below. */
  floorRuns: number;
  /** totalRuns - floorRuns. The denominator the stats actually use. */
  usableRuns: number;
  /**
   * False when fewer than two usable runs back this section. The renderers
   * must say so rather than printing a mean of one run as if it were a trend
   * — a single cold start is a measurement, not a rate.
   */
  isTrend: boolean;
  billedUsd: SampleStat;
  listUsd: SampleStat;
  calls: SampleStat;
  cardsWritten: SampleStat;
  articleCount: SampleStat;
}

export interface CostReport {
  schemaVersion: 1;
  totalRuns: number;
  /** Lines the parser could not use. Shown, so a silently shrinking sample is visible. */
  skippedLines: number;
  floorRuns: number;
  /**
   * Records handed in that this report refused to include at all — an
   * unrecognised route or run shape (no section can hold them), or a dollar
   * figure that cannot be true (negative or non-finite). Excluded from
   * `totalRuns` and from every statistic, and shown, so the headline can never
   * silently disagree with the sum of the sections below it.
   *
   * Three different exclusions live on this report and they are not the same
   * thing, so: `skippedLines` is lines the PARSER could not read;
   * `excludedRuns` is records the REPORT would not accept; `floorRuns` is
   * records it did accept and count, but will not average.
   *
   * Always 0 for records that came through `parseUsageRunLines`, which rejects
   * them earlier and counts them in `skippedLines`. Nonzero means a caller
   * supplied records from somewhere else.
   */
  excludedRuns: number;
  /** YYYY-MM-DD, from the earliest and latest priced instant. Null when nothing is dated. */
  firstRunDate: string | null;
  lastRunDate: string | null;
  /**
   * Every distinct `pricingVerifiedOn` across the runs. More than one means
   * the report spans a pricing correction and its figures are not all on the
   * same rate card — which is exactly what happened on 2026-09-11 and took
   * eleven days to notice.
   */
  pricingVerifiedOn: string[];
  sections: CostReportSection[];
}

/**
 * The only run shapes this report knows how to place.
 *
 * Shared by the validator and the grouping loop ON PURPOSE. They were
 * separate lists, and the gap between them was a silent-data-loss bug: the
 * validator accepted any string, the grouping loop matched only these four,
 * so a record carrying anything else was counted in the headline
 * `**N runs**` and in `floorRuns` and in the date range, but appeared in no
 * section at all. The page's own total disagreed with the sum of what it
 * showed, and nothing on it said why. One list means the validator can only
 * admit what the loop can place.
 */
const RUN_SHAPES = ["cold", "warmNewDay", "warmSameDay", "unknown"] as const;

/** The routes a section can be keyed by. Paired with RUN_SHAPES, above. */
const ROUTES = ["digest", "expand"] as const;

/**
 * An ISO-8601 instant of the shape `toISOString()` produces.
 *
 * A type check alone was not enough, which is the milder half of the same
 * fabrication: `new Date()` is lenient with STRINGS too, so a hand-corrupted
 * `"09/11/2026"` parses to a real date (2026-09-11) rather than being
 * rejected. Less dangerous than the numeric case — that one silently shifted
 * the year — but the same shape, and one pattern closes it.
 *
 * Deliberately accepts more than `toISOString()` emits (optional fractional
 * seconds, a numeric offset instead of `Z`), because over-rejection here would
 * silently shrink the sample, which is the worse failure of the two.
 *
 * The one legitimate form it does NOT accept, named because every other edge
 * case in this file carries a note and leaving this one silent would be the
 * inconsistency: `toISOString()` uses an expanded year (`+275760-09-13T…`,
 * or a signed negative year) outside the four-digit range 0000-9999, and
 * `^\d{4}` rejects those. Unreachable here — `buildUsageRunRecord` is only
 * ever handed the collector's `at`, a real-time `Date` — so the pattern stays
 * simple rather than growing a branch for instants no run can produce.
 */
function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)
  );
}

function isRoute(value: unknown): value is PublicUsageRunRecord["route"] {
  return typeof value === "string" && (ROUTES as readonly string[]).includes(value);
}

function isRunShape(value: unknown): value is RunShape {
  return typeof value === "string" && (RUN_SHAPES as readonly string[]).includes(value);
}

/**
 * The section this record belongs in, or null when this report has no section
 * that can hold it.
 *
 * ONE function, called by both the partition and the grouping loop, because
 * this bug shape has now appeared three times and each fix only closed the
 * field it was looking at. First a bad `runShape` slipped past the validator;
 * then the partition was added but checked `runShape` alone while the section
 * key is `(route, runShape)`, so a bad ROUTE walked straight through the guard
 * written to make that impossible — and `excludedRuns` reported 0, actively
 * asserting everything was accounted for when it was not.
 *
 * Two lists gating placement in two places is what kept regenerating the bug.
 * Now a record is kept if and only if this function finds it a bucket, and the
 * buckets are built from the same call — so "counted but shown nowhere" is not
 * a state the code can express, rather than one no current test triggers.
 */
function sectionKeyOf(record: { route?: unknown; runShape?: unknown }): string | null {
  if (!isRoute(record.route) || !isRunShape(record.runShape)) return null;
  return `${record.route}|${record.runShape}`;
}


/**
 * Reads JSONL into records, keeping the unusable ones countable.
 *
 * Skips rather than throws, and reports how many it skipped. A report that
 * dies on one truncated last line (the normal result of a process killed
 * mid-write) would be useless exactly when something went wrong, while a
 * report that silently dropped lines would quietly shrink its own sample.
 */
export function parseUsageRunLines(lines: string[]): {
  records: PublicUsageRunRecord[];
  skipped: number;
} {
  const records: PublicUsageRunRecord[] = [];
  let skipped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isUsableRecord(parsed)) {
      skipped += 1;
      continue;
    }
    records.push(parsed);
  }

  return { records, skipped };
}

/**
 * THE validator. One function, called by the parser and by
 * `buildCostReport`, because two of them is what kept regenerating the same
 * bug.
 *
 * THE HISTORY, told once and only here — other comments point at this one,
 * because two docstrings narrating it separately is how their counts drifted
 * apart. Five review rounds found five instances of a single shape: a guard
 * that existed on one path into the report and not the other.
 *
 * 1. The validator accepted any string as `runShape`, so a record the
 *    grouping loop could not place was counted in the headline anyway.
 * 2. `buildCostReport` had no placement guard at all, so a direct caller
 *    reproduced (1) even after the validator was fixed.
 * 3. The partition it then grew checked `runShape` but not `route` — and the
 *    section key is the PAIR, so a bad route walked through the guard written
 *    to make that impossible.
 * 4. That partition checked placement and dollars, but not `pricingVerifiedOn`
 *    (which crashed both renderers), `schemaVersion`, or `isFloor`.
 * 5. `pricedAtIso` went unchecked here, and `utcDate` coerces a number into a
 *    plausible date rather than rejecting it — the only one of the five that
 *    invented an answer instead of losing a record.
 *
 * Rounds 1-4 each widened the narrower guard by exactly the field that round
 * had found, which is precisely why there was always another field. The
 * narrower guard is gone now.
 *
 * There is no second guard now. A record is admitted here or not at all, and
 * a field added to this function is enforced on every path by construction
 * rather than by remembering to add it twice.
 *
 * Checks `schemaVersion` explicitly. A future version 2 with different
 * semantics must not be silently averaged in with version 1 — that is the
 * whole reason the field is on the record, and skipping is the honest
 * response until a reader is written that understands both.
 */
function isUsableRecord(value: unknown): value is PublicUsageRunRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PublicUsageRunRecord>;
  return (
    // A future version 2 may mean something different by the same field
    // names. Averaging it in with version 1 is what this field exists to stop.
    record.schemaVersion === 1 &&
    // Placement, through the SAME function the grouping loop matches on. A
    // record this report cannot place must be refused here, never admitted
    // and then quietly dropped by a loop that has no bucket for it.
    sectionKeyOf(record) !== null &&
    typeof record.totalBilledUsd === "number" &&
    Number.isFinite(record.totalBilledUsd) &&
    record.totalBilledUsd >= 0 &&
    typeof record.totalListUsd === "number" &&
    Number.isFinite(record.totalListUsd) &&
    record.totalListUsd >= 0 &&
    // typeof, not truthiness. `isFloor: "false"` is a TRUTHY string, so
    // `!record.isFloor` is false and the run is dropped from the usable set —
    // i.e. a record explicitly saying "false" would be treated AS a floor and
    // silently excluded from every average. (An earlier version of this
    // comment had that backwards; `!"false"` is `false`, not `true`.) Either
    // direction is a confidently-wrong classification, which this module
    // treats as worse than a crash.
    typeof record.isFloor === "boolean" &&
    // Null or a string, never a bare number. `utcDate` asks only whether the
    // resulting Date is finite, and `new Date(...)` coerces a number through
    // ToNumber — so a corrupted numeric timestamp does not fail, it produces a
    // PLAUSIBLE date (1757600000000 renders as 2025-09-11) that flows into
    // firstRunDate/lastRunDate and is shown as fact. Every other gap in this
    // family made a record vanish; this one invents an answer.
    (record.pricedAtIso === null || isIsoInstant(record.pricedAtIso)) &&
    // Required, and read into the "Claude calls" statistic. Left unchecked it
    // would not fabricate anything — `sampleStat` would just drop it and
    // shrink that one stat's `n` — but there is no reason for the validator to
    // cover every other required field it reads and not this one.
    typeof record.totalCalls === "number" &&
    Number.isFinite(record.totalCalls) &&
    record.totalCalls >= 0 &&
    // Checked because it is the one record-derived STRING that reaches a
    // renderer, and `mdInline` calls `.replace()` on it. A hand-edited line
    // carrying a number or a null passed validation and then threw a
    // TypeError mid-render, taking the whole report down — the opposite of
    // this parser's stated promise to survive a malformed file.
    typeof record.pricingVerifiedOn === "string"
  );
}

/**
 * Mean/min/max over the values that exist, with absences excluded rather than
 * zeroed.
 *
 * Takes `unknown[]` and filters on being a FINITE NUMBER, not merely on being
 * non-null. The type says these fields are `number | null`, but the records
 * come off a file on disk, and this module already assumes that file can be
 * malformed — it has explicit handling for a truncated last line. A stray
 * `undefined`, a string, or a NaN passed the old `!== null` filter and went
 * straight into the sum, turning one bad field into a NaN mean for the whole
 * section. Excluding it is the same treatment null gets, for the same reason:
 * a value that cannot be measured must not be counted as one.
 *
 * What the widening COSTS, named because it is a trade and not a free win:
 * with `(number | null)[]` the compiler caught a call site passing the wrong
 * field; with `unknown[]` such a typo type-checks and shows up only as a
 * quietly lower `n`. Accepted because the runtime hazard is the live one —
 * these values come off a hand-editable file — and because the function is
 * private, so all five call sites are in view here.
 */
function sampleStat(values: unknown[]): SampleStat {
  const present = values.filter(
    // Non-negative too, not just finite. EVERY quantity this function
    // summarises is a cost or a count, and neither can be below zero — so a
    // negative is corrupt input, not a measurement. `totalBilledUsd`,
    // `totalListUsd` and `totalCalls` are already sign-checked by
    // `isUsableRecord`, but `cardsWritten` and `articleCount` are nullable and
    // reach here unguarded: a record with `cardsWritten: -5` alongside one
    // with 8 rendered a mean of 1.5, silently, with no exclusion notice. The
    // record itself stays — one bad optional field is not grounds to discard a
    // run's cost — and the bad value is dropped from this one statistic, which
    // is exactly how null and NaN are already treated. `n` shows the smaller
    // denominator.
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
  );
  if (present.length === 0) return { n: 0, mean: null, min: null, max: null };
  return {
    n: present.length,
    mean: present.reduce((sum, value) => sum + value, 0) / present.length,
    min: Math.min(...present),
    max: Math.max(...present),
  };
}

/** YYYY-MM-DD from an ISO instant, or null if it is unusable. */
function utcDate(iso: string | null): string | null {
  // typeof, not `=== null`. This is where the fabrication happened —
  // `new Date(aNumber)` is finite and plausible, so the isFinite test below
  // cannot catch it — and this function should not depend on a caller having
  // checked first.
  //
  // Unreachable today, and untested for that reason: `isUsableRecord` already
  // guarantees the type on every path in, so reverting this line to
  // `=== null` fails nothing. Kept because the guard costs one comparison and
  // the function is then correct on its own terms rather than on its caller's.
  if (typeof iso !== "string") return null;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Every number in the report, computed once, here.
 *
 * Sections come out in a stable order — digests before expands, and within a
 * route the shapes in pipeline order (cold, warmNewDay, warmSameDay, unknown)
 * — so regenerating an unchanged log produces a byte-identical report and
 * `git diff` on the committed markdown shows real movement rather than
 * reordering noise.
 */
export function buildCostReport(
  /** NOT assumed to have come from `parseUsageRunLines` — see `unplaceableRuns`. */
  allRecords: PublicUsageRunRecord[],
  /**
   * Carried in from `parseUsageRunLines`, because only the parser knows it and
   * only the report can show it. Defaulted rather than required so a caller
   * holding records from elsewhere is not forced to invent a number — but the
   * script MUST pass the real one, or a log that is quietly losing lines
   * reports a clean bill of health.
   */
  skippedLines = 0
): CostReport {
  // Partitioned FIRST, through the same validator the parser uses, so every
  // total below is computed from records that actually appear in a section.
  //
  // The structural half of a fix whose first half was not enough. Validating
  // `runShape` in `isUsableRecord` closed the hole for the one caller that
  // goes through the parser — but this function is the exported reusable core
  // (the script's own comment anticipates a second reader sourcing records
  // from Supabase), and called directly it counted an unplaceable record in
  // `totalRuns` while no section could hold it. The page's headline then
  // disagreed with the sum of the sections printed beneath it. Deriving the
  // totals from the placed set makes that arithmetic impossible rather than
  // merely currently-absent.
  const records = allRecords.filter(isUsableRecord);
  const excludedRuns = allRecords.length - records.length;

  const dates = records
    .map((record) => utcDate(record.pricedAtIso))
    .filter((date): date is string => date !== null)
    .sort();

  const sections: CostReportSection[] = [];
  for (const route of ROUTES) {
    for (const runShape of RUN_SHAPES) {
      // Matched through the SAME function the partition used.
      //
      // Precisely what this does and does not buy, because mutation testing
      // disproved the stronger claim that was here first: re-comparing the two
      // fields inline is behaviourally IDENTICAL today, and swapping it back
      // fails no test. The hazard was never the comparison style — it was the
      // partition applying a NARROWER rule than the loop, which is how a bad
      // route passed a guard that checked only the shape. Routing both through
      // one function is what makes a narrower-rule bug unwritable; it is a
      // structural choice, not a tested behaviour, and saying otherwise would
      // be inventing a guarantee the tests do not hold.
      const key = `${route}|${runShape}`;
      const group = records.filter((record) => sectionKeyOf(record) === key);
      if (group.length === 0) continue;

      // The exclusion that makes every stat below honest.
      const usable = group.filter((record) => !record.isFloor);
      sections.push({
        route,
        runShape,
        totalRuns: group.length,
        floorRuns: group.length - usable.length,
        usableRuns: usable.length,
        isTrend: usable.length >= 2,
        billedUsd: sampleStat(usable.map((record) => record.totalBilledUsd)),
        listUsd: sampleStat(usable.map((record) => record.totalListUsd)),
        calls: sampleStat(usable.map((record) => record.totalCalls)),
        cardsWritten: sampleStat(usable.map((record) => record.cardsWritten)),
        articleCount: sampleStat(usable.map((record) => record.articleCount)),
      });
    }
  }

  return {
    schemaVersion: 1,
    totalRuns: records.length,
    skippedLines,
    floorRuns: records.filter((record) => record.isFloor).length,
    excludedRuns,
    firstRunDate: dates[0] ?? null,
    lastRunDate: dates[dates.length - 1] ?? null,
    pricingVerifiedOn: [...new Set(records.map((record) => record.pricingVerifiedOn))].sort(),
    sections,
  };
}

/** Human label for a section, used identically by both renderers. */
export function sectionTitle(section: CostReportSection): string {
  const shape: Record<RunShape, string> = {
    cold: "Cold start",
    warmNewDay: "Warm, new day",
    warmSameDay: "Warm, same day",
    unknown: "Unclassified",
  };
  return `${section.route === "digest" ? "Digest" : "Expand"} — ${shape[section.runShape]}`;
}

/**
 * Every figure that must survive into BOTH rendered outputs, as the exact
 * strings they should appear as.
 *
 * Deliberately NOT called by either renderer. If it were, a renderer could
 * drop a figure and this would happily agree with it — the check has to come
 * from somewhere the renderers do not read. It is the spec; they are two
 * independent implementations of it; a test holds them to it.
 */
export function headlineFigures(report: CostReport): string[] {
  const figures: string[] = [`${report.totalRuns} runs`];
  if (report.floorRuns > 0) figures.push(`${report.floorRuns} counted but not averaged`);
  if (report.skippedLines > 0) figures.push(`${report.skippedLines} unreadable`);
  if (report.excludedRuns > 0) figures.push(`${report.excludedRuns} rejected as unusable`);
  if (report.firstRunDate !== null) figures.push(report.firstRunDate);
  if (report.lastRunDate !== null) figures.push(report.lastRunDate);

  for (const section of report.sections) {
    figures.push(sectionTitle(section));
    // Row LABELS, not their values. A label is distinctive enough that its
    // absence means the row is gone, whereas a value like "8" could match
    // somewhere else on the page by coincidence and report parity that is not
    // there. Review found the parity check covered only the two dollar means,
    // so a renderer could have silently dropped three of the five rows.
    figures.push("Billed (USD)", "At list (USD)", "Claude calls", "Cards written", "Articles ingested");
    if (section.billedUsd.mean !== null) figures.push(formatUsd(section.billedUsd.mean));
    if (section.listUsd.mean !== null) figures.push(formatUsd(section.listUsd.mean));
  }
  return figures;
}

/** `n = 12` / the explicit not-a-trend notice. Shared wording, one source. */
function sampleNote(section: CostReportSection): string {
  // Says "not a trend" here too. The rule is that fewer than two usable runs
  // renders that phrase, and zero is fewer than two — an earlier version
  // returned a message that was arguably clearer and did not contain it,
  // which made the section the one place the rule silently did not apply.
  if (section.usableRuns === 0) return "no usable runs, not a trend — every run here is a floor";
  if (!section.isTrend) return `n = ${section.usableRuns}, not a trend`;
  return `n = ${section.usableRuns}`;
}

function stat(value: number | null, digits = 2): string {
  return value === null ? "—" : value.toFixed(digits);
}

/**
 * A dollar figure for a table cell, preserving the one guarantee `formatUsd`
 * exists to make: a nonzero cost is never rendered as a row of zeros.
 *
 * Found by review — `stat(v, 6)` printed `0.000000` for a run that cost
 * \$0.0000003, in the same report whose prose line correctly said
 * `<\$0.000001` for that identical number. A cost report disagreeing with
 * itself about whether something was free is exactly the confidently-wrong
 * output this subsystem exists to prevent. The `$` is omitted because the ROW
 * LABEL carries the unit (`Billed (USD)`), not the column header.
 */
function statUsd(value: number | null): string {
  if (value === null) return "—";
  // Magnitude, not sign: -0.0000003 formatted as "-0.000000", which reads as
  // a signed zero rather than a real figure.
  //
  // No caller can reach this branch today — `isUsableRecord` drops a
  // negative total on every path into the report, so the guard is kept for
  // being correct over its whole domain rather than for a path anyone can
  // take. Stated plainly so nobody later reads it as evidence that negatives
  // are expected here; they are not.
  //
  // The threshold is IMPORTED, not repeated. A second literal is what let the
  // table and the prose disagree in the first place, and a copy would let them
  // drift apart again the next time it moves, silently.
  if (value !== 0 && Math.abs(value) < SMALLEST_SHOWN_USD) {
    return `${value < 0 ? "-" : ""}<${SMALLEST_SHOWN_USD.toFixed(6)}`;
  }
  return value.toFixed(6);
}

/**
 * Strips what would break an inline code span or the document's line
 * structure. `pricingVerifiedOn` is the one record-derived string that
 * reaches markdown prose, and the file it comes from is hand-editable.
 *
 * This ALTERS the recorded value rather than preserving it, which deserves
 * naming in a module about faithful measurement. CommonMark would allow a
 * wider code fence to carry a literal backtick untouched. Substitution wins
 * here only because this field is provenance metadata rather than a measured
 * quantity, and a backtick in a date can only arrive by corruption — the same
 * licence would NOT extend to a dollar figure, which is never rewritten.
 */
function mdInline(text: string): string {
  return text.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
}

/**
 * Obsidian pairs `$` characters ACROSS line breaks as math delimiters, so two
 * of them in a document swallow everything between them and the table stops
 * rendering. A literal dollar outside a code fence is always a bug in this
 * vault, and every dollar figure in this report is one.
 */
function escapeDollars(text: string): string {
  return text.replace(/\$/g, "\\$");
}

/**
 * The committed report. **No generation timestamp anywhere in the body** —
 * `(C) COST.md` is tracked precisely so `git diff` is the trend history, and
 * a timestamp would make every regeneration a diff even when no number moved.
 * The run count and the date range carry the same information and only change
 * when the data does.
 */
export function renderCostMarkdown(report: CostReport): string {
  const lines: string[] = [];
  lines.push("# Cost report");
  lines.push("");
  lines.push(
    "Generated by `npm run cost-report` from `notes-logs/cost/runs.jsonl`. Every figure here is computed from recorded runs — nothing in this file is typed by hand, which is the point of it existing."
  );
  lines.push("");

  const range =
    report.firstRunDate === null || report.lastRunDate === null
      ? "no dated runs"
      : report.firstRunDate === report.lastRunDate
        ? report.firstRunDate
        : `${report.firstRunDate} to ${report.lastRunDate}`;
  lines.push(`**${report.totalRuns} runs**, ${range}.`);
  lines.push("");

  if (report.floorRuns > 0) {
    lines.push(
      `**${report.floorRuns} counted but not averaged.** These runs ARE in the counts and the sections above; they are simply left out of every average. A floor run's total is a lower bound — a billed call reported no usage, or a model could not be priced — so the real spend is higher by an unknown amount, and an unknown shortfall folded into a mean is invisible once it is in there.`
    );
    lines.push("");
  }
  if (report.skippedLines > 0) {
    lines.push(
      `**${report.skippedLines} unreadable** line(s) in the log were skipped, so the sample is smaller than the file.`
    );
    lines.push("");
  }
  if (report.excludedRuns > 0) {
    lines.push(
      `**${report.excludedRuns} rejected as unusable** — an unrecognised route or run shape, or a dollar figure that cannot be true. They are left out of the count above and out of every section, because there is no honest place to put them.`
    );
    lines.push("");
  }
  if (report.pricingVerifiedOn.length > 1) {
    lines.push(
      `**These runs span more than one rate card** (\`${report.pricingVerifiedOn.map(mdInline).join("`, `")}\`). Figures from either side of a pricing correction are not comparable without repricing.`
    );
    lines.push("");
  }

  if (report.sections.length === 0) {
    lines.push("No runs recorded yet.");
    lines.push("");
    return escapeDollars(lines.join("\n"));
  }

  lines.push(
    "Sections are split by route and run shape on purpose. A cold start and a returning-user run cost materially different amounts, so there is no combined average anywhere in this report — a blended figure would describe no real user."
  );
  lines.push("");

  for (const section of report.sections) {
    lines.push(`## ${sectionTitle(section)}`);
    lines.push("");
    lines.push(
      `${section.totalRuns} run(s) recorded, ${sampleNote(section)}${section.floorRuns > 0 ? `, ${section.floorRuns} excluded as a floor` : ""}.`
    );
    lines.push("");
    lines.push("| Measure | Mean | Min | Max | Samples |");
    lines.push("|---|---|---|---|---|");
    lines.push(
      `| Billed (USD) | ${statUsd(section.billedUsd.mean)} | ${statUsd(section.billedUsd.min)} | ${statUsd(section.billedUsd.max)} | ${section.billedUsd.n} |`
    );
    lines.push(
      `| At list (USD) | ${statUsd(section.listUsd.mean)} | ${statUsd(section.listUsd.min)} | ${statUsd(section.listUsd.max)} | ${section.listUsd.n} |`
    );
    lines.push(
      `| Claude calls | ${stat(section.calls.mean, 1)} | ${stat(section.calls.min, 0)} | ${stat(section.calls.max, 0)} | ${section.calls.n} |`
    );
    lines.push(
      `| Cards written | ${stat(section.cardsWritten.mean, 1)} | ${stat(section.cardsWritten.min, 0)} | ${stat(section.cardsWritten.max, 0)} | ${section.cardsWritten.n} |`
    );
    lines.push(
      `| Articles ingested | ${stat(section.articleCount.mean, 1)} | ${stat(section.articleCount.min, 0)} | ${stat(section.articleCount.max, 0)} | ${section.articleCount.n} |`
    );
    lines.push("");
    if (section.billedUsd.mean !== null && section.listUsd.mean !== null) {
      // Both, rather than one guard and a `?? 0` fallback. A record is only
      // usable when BOTH dollar fields are finite numbers, so these two are
      // null together or not at all — and a `?? 0` would have rendered a
      // fabricated zero if that ever stopped being true.
      lines.push(
        `Mean billed per run: ${formatUsd(section.billedUsd.mean)} (at list ${formatUsd(section.listUsd.mean)}).`
      );
      lines.push("");
    }
  }

  if (report.pricingVerifiedOn.length === 1) {
    lines.push(
      `Rates last verified against published pricing ${mdInline(report.pricingVerifiedOn[0])}. That means checked against Anthropic's published rate card, which is a different act from reconciling against a Console invoice — only the former is automated.`
    );
    lines.push("");
  }

  return escapeDollars(lines.join("\n"));
}

/** The same struct, laid out for a browser. Computes nothing the markdown didn't. */
export function renderCostHtml(report: CostReport): string {
  const esc = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const range =
    report.firstRunDate === null || report.lastRunDate === null
      ? "no dated runs"
      : report.firstRunDate === report.lastRunDate
        ? report.firstRunDate
        : `${report.firstRunDate} to ${report.lastRunDate}`;

  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="en"><head><meta charset="utf-8">');
  parts.push("<title>Cost report</title>");
  parts.push(
    "<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.5}" +
      "table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:right}" +
      "th:first-child,td:first-child{text-align:left}caption{text-align:left;font-weight:600;margin-bottom:.4rem}" +
      ".note{background:#f6f6f6;padding:.6rem .8rem;border-left:3px solid #999}</style>"
  );
  parts.push("</head><body>");
  parts.push("<h1>Cost report</h1>");
  parts.push(
    `<p><strong>${report.totalRuns} runs</strong>, ${esc(range)}.</p>`
  );

  if (report.floorRuns > 0) {
    parts.push(
      `<p class="note"><strong>${report.floorRuns} counted but not averaged.</strong> These runs ARE in the counts and the sections above; they are simply left out of every average, because a floor run's total is a lower bound — a billed call reported no usage, or a model could not be priced.</p>`
    );
  }
  if (report.skippedLines > 0) {
    parts.push(
      `<p class="note"><strong>${report.skippedLines} unreadable</strong> line(s) in the log were skipped, so the sample is smaller than the file.</p>`
    );
  }
  if (report.excludedRuns > 0) {
    parts.push(
      `<p class="note"><strong>${report.excludedRuns} rejected as unusable</strong> — an unrecognised route or run shape, or a dollar figure that cannot be true. They are left out of the count above and out of every section.</p>`
    );
  }
  if (report.pricingVerifiedOn.length > 1) {
    parts.push(
      `<p class="note"><strong>These runs span more than one rate card</strong> (${esc(report.pricingVerifiedOn.join(", "))}). Figures from either side of a pricing correction are not comparable without repricing.</p>`
    );
  }

  if (report.sections.length === 0) {
    parts.push("<p>No runs recorded yet.</p>");
    parts.push("</body></html>");
    return parts.join("\n");
  }

  parts.push(
    "<p>Sections are split by route and run shape on purpose. A cold start and a returning-user run cost materially different amounts, so there is no combined average anywhere in this report.</p>"
  );

  for (const section of report.sections) {
    parts.push(`<h2>${esc(sectionTitle(section))}</h2>`);
    parts.push(
      `<p>${section.totalRuns} run(s) recorded, ${esc(sampleNote(section))}${section.floorRuns > 0 ? `, ${section.floorRuns} excluded as a floor` : ""}.</p>`
    );
    parts.push("<table><tr><th>Measure</th><th>Mean</th><th>Min</th><th>Max</th><th>Samples</th></tr>");
    const usdRow = (label: string, s: SampleStat) =>
      `<tr><td>${label}</td><td>${statUsd(s.mean)}</td><td>${statUsd(s.min)}</td><td>${statUsd(s.max)}</td><td>${s.n}</td></tr>`;
    const row = (label: string, s: SampleStat, digits: number, minMaxDigits = digits) =>
      `<tr><td>${label}</td><td>${stat(s.mean, digits)}</td><td>${stat(s.min, minMaxDigits)}</td><td>${stat(s.max, minMaxDigits)}</td><td>${s.n}</td></tr>`;
    parts.push(usdRow("Billed (USD)", section.billedUsd));
    parts.push(usdRow("At list (USD)", section.listUsd));
    parts.push(row("Claude calls", section.calls, 1, 0));
    parts.push(row("Cards written", section.cardsWritten, 1, 0));
    parts.push(row("Articles ingested", section.articleCount, 1, 0));
    parts.push("</table>");
    if (section.billedUsd.mean !== null && section.listUsd.mean !== null) {
      parts.push(
        `<p>Mean billed per run: ${esc(formatUsd(section.billedUsd.mean))} (at list ${esc(formatUsd(section.listUsd.mean))}).</p>`
      );
    }
  }

  if (report.pricingVerifiedOn.length === 1) {
    parts.push(
      `<p>Rates last verified against published pricing ${esc(report.pricingVerifiedOn[0])}.</p>`
    );
  }

  parts.push("</body></html>");
  return parts.join("\n");
}
