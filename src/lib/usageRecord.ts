/**
 * The durable, machine-readable shape of one Claude-spending run.
 *
 * `usage.ts` prices a run and `formatUsageSummary` renders it for a human.
 * Neither leaves anything behind: the only sink was `console.log`, so every
 * cost figure this project has ever published was read off terminal
 * scrollback and retyped into markdown by hand. Averages and trends were
 * therefore uncomputable — not hard, uncomputable, because no two runs were
 * ever recorded in the same place in the same shape.
 *
 * This module is the shape half of the fix: it turns a `UsageSummary` plus
 * the run's own context into one flat record that a file, a table and a
 * report generator can all read. It is **pure** — no I/O, no clock, no
 * randomness — for the same reason `usage.ts` is: the arithmetic that sizes
 * V2.0's spend caps has to be testable without a filesystem or a network.
 * `usageSinks.ts` owns the writing; `costReport.ts` owns the reading.
 *
 * It inherits `usage.ts`'s bar — **a confidently-wrong number is worse than
 * a crash** — and that is why almost every context field below is nullable.
 * A run that exits early never learns how many cards it wrote, and
 * `cardsWritten: null` ("never got there") is a different fact from
 * `cardsWritten: 0` ("got there, wrote nothing"). Collapsing them would put
 * a zero into a mean that should have excluded the sample entirely. Nothing
 * here may default to 0.
 */

// RELATIVE with an explicit `.ts` extension, and not a style choice — see the
// same note in `costReport.ts`. `scripts/cost-report.mts` reaches this module
// through Node's native type stripping, which does not know the `@/` alias, so
// the whole chain it can reach (cost-report.mts -> costReport.ts ->
// usageRecord.ts -> usage.ts) has to resolve without one. `usage.ts` is a leaf
// and imports nothing, so the chain ends there. A VALUE import is what makes
// this bite; a type-only import is erased and would not.
import {
  PRICING_VERIFIED_ON,
  type CallTokens,
  type TrackedModel,
  type UsageStage,
  type UsageSummary,
} from "./usage.ts";
import type { CardFailure } from "./cardFailure.ts";

/**
 * How much work a digest run had to do from scratch — the single biggest
 * driver of what it costs, and the thing every published figure so far has
 * silently averaged over.
 *
 * The names here are the PRODUCT's names, not the cursor's. A day opens with
 * a fresh brief and "Complete Today's Brief" tops it up, so those are the two
 * shapes a reader of a cost report is thinking in. An earlier version named
 * these `cold`/`warmNewDay`/`warmSameDay`, which inverted that vocabulary —
 * what the product calls the normal daily brief was labelled "warm", as if it
 * were an incremental top-up, and a session misread real measurements off the
 * label within an hour of them landing.
 *
 * **What this axis does NOT capture, and the reason it cannot size a cap on
 * its own.** `LOOKBACK_CEILING_MS` is 48h, so a null cursor and a three-day-old
 * one produce an identical ingest window (`ingest.ts` says as much: a brand-new
 * user gets 48h, "someone returning after a week gets 48h too"), and
 * `filterAlreadyCovered` is gated on today's cards existing, so both skip dedup
 * as well. `firstEver` and a `firstOfDay` that follows a long gap are therefore
 * THE SAME RUN in every respect that bills — two of these three labels collapse
 * whenever the gap exceeds the ceiling. The fact that actually drives cost is
 * the effective ingest window, `min(now - cursor, 48h)`, as a number rather
 * than a bucket, plus whether dedup fired. Recording those two is tracked in
 * `ROADMAP.md`'s V2.0 as blocking the cap sizing; this rename does not do it.
 */
export type RunShape =
  /** No successful generation has ever run for this user. Full lookback, no dedup. */
  | "firstEver"
  /** The day's first brief: cursor set, no cards yet today, so nothing to dedup against. */
  | "firstOfDay"
  /** "Complete Today's Brief" — a second or later run today, so today's cards exist and dedup bills. */
  | "sameDayTopUp"
  /**
   * Not determinable. Two causes, both real: the existing-cards fetch failed
   * (so the pipeline itself proceeded on an incomplete view), or the route
   * has no first-of-day/top-up dimension at all — an expand is a single cached-miss
   * Sonnet call and is neither. Reports must segment by route as well as
   * shape so those two never share a mean.
   */
  | "unknown";

/**
 * Every current run shape, in pipeline order. The single list — `costReport`
 * imports this rather than keeping its own, because two lists that must agree
 * is the exact shape of the bug family this module already has five instances
 * of.
 */
export const RUN_SHAPES = ["firstEver", "firstOfDay", "sameDayTopUp", "unknown"] as const;

// Compile-time proof that the list and the union agree in BOTH directions, so
// adding a shape to one and forgetting the other is a `tsc` error rather than
// a shape that silently groups nowhere. Cheap here; the promo-state entry in
// ROADMAP.md wants the same move for a harder case.
type ListCoversUnion = Exclude<RunShape, (typeof RUN_SHAPES)[number]> extends never ? true : never;
type UnionCoversList = Exclude<(typeof RUN_SHAPES)[number], RunShape> extends never ? true : never;
const RUN_SHAPE_LIST_IS_TOTAL: [ListCoversUnion, UnionCoversList] = [true, true];
void RUN_SHAPE_LIST_IS_TOTAL;

export type RunOutcome = "complete" | "endedEarly";

/**
 * Classifies a digest run from the two facts the route knows before the
 * pipeline starts spending.
 *
 * `existingCardCount: null` means the `getTodaysCardSummaries` fetch FAILED
 * — not that it returned nothing. The digest route already treats those two
 * differently (a failed fetch gates ranking off entirely), and so does this.
 *
 * `sinceIso` is read as a null/non-null signal only; its contents are never
 * parsed. A malformed-but-present cursor still means a generation completed
 * once, which is the only thing this classification turns on.
 */
export function deriveRunShape(
  sinceIso: string | null,
  existingCardCount: number | null
): RunShape {
  if (existingCardCount === null) {
    // The count is unknown, but a null cursor is decisive on its own: cards
    // and the cursor advance in the same transaction (persist_generated_cards),
    // so a user who has never completed a run cannot have cards today. Only
    // the case where the cursor IS set leaves the warm/warm split unresolved.
    return sinceIso === null ? "firstEver" : "unknown";
  }
  if (sinceIso === null) {
    // Cards with no cursor contradicts persist_generated_cards' atomicity.
    // Whatever produced it, the run is genuinely mixed — a cold 48h lookback
    // that will nonetheless pay for dedup — so it belongs in no clean bucket.
    return existingCardCount > 0 ? "unknown" : "firstEver";
  }
  return existingCardCount > 0 ? "sameDayTopUp" : "firstOfDay";
}

/**
 * Run-shape names from the earlier vocabulary, mapped to their current
 * equivalents.
 *
 * This exists because the old rows CANNOT be rewritten: `usage_runs` has no
 * update and no delete policy, and their absence is the design (see
 * `schema.sql`). Migrating the durable copy is therefore not an option that
 * exists, so normalising on read is the only place the two vocabularies can
 * ever be reconciled. The local JSONL is deliberately left unmigrated too —
 * one reader-side mechanism that handles both sources beats a file rewrite
 * plus a mapping that must agree with it forever.
 *
 * **Known, accepted exposure, stated rather than implied:** this reconciles the
 * READERS, not the files. `runs.jsonl` still holds raw legacy strings on disk,
 * so anything reading it without going through `costReport.ts` — a `jq`
 * one-liner, an ad-hoc script — sees `cold`/`warmNewDay`/`warmSameDay` and must
 * map them itself. No such consumer exists today (checked across both route
 * handlers, `costReport.ts` and `usageSinks.ts`); this note is here so the next
 * one is written knowing it.
 */
const LEGACY_RUN_SHAPE: Readonly<Record<string, RunShape>> = Object.freeze({
  cold: "firstEver",
  warmNewDay: "firstOfDay",
  warmSameDay: "sameDayTopUp",
});

/**
 * Reads a persisted `runShape` into the current vocabulary, or null if it is
 * not a run shape at all.
 *
 * Every consumer goes through this rather than comparing strings, so a record
 * written before the rename groups with its post-rename equivalents instead of
 * silently falling out of the report — which is exactly the "counted in the
 * headline, shown in no section" failure this module's validator history is
 * already made of. `Object.hasOwn` rather than a bare lookup, for the same
 * reason the pricing table uses it: a polluted prototype must not be able to
 * supply a shape.
 */
export function normalizeRunShape(value: unknown): RunShape | null {
  if (typeof value !== "string") return null;
  if ((RUN_SHAPES as readonly string[]).includes(value)) return value as RunShape;
  return Object.hasOwn(LEGACY_RUN_SHAPE, value) ? LEGACY_RUN_SHAPE[value] : null;
}

/**
 * What the route knows about the run, assembled as the facts become
 * available and read once from the `finally` block.
 *
 * Every field that a run can exit before learning is `| null`. See the
 * module header: null is "never measured", 0 is a measurement.
 */
export interface UsageRunContext {
  userId: string;
  route: "digest" | "expand";
  digestId: string | null;
  cardId: string | null;
  outcome: RunOutcome;
  /** The exact label string `usage.report()` used, so a row and a log line can be matched up. */
  label: string;
  runShape: RunShape;
  topicCount: number | null;
  sourceCount: number | null;
  articleCount: number | null;
  clusterCount: number | null;
  clustersAfterDedup: number | null;
  /** Notable clusters AFTER `applyCardCap` — i.e. what writeCard was actually asked for. */
  notableCount: number | null;
  cardsDroppedByCap: number | null;
  cardsWritten: number | null;
  cardsFailed: number | null;
  /** Why each of `cardsFailed` produced no card, one entry per failure. */
  cardFailures: CardFailure[] | null;
  /** Clusters triage could not judge and dropped, as distinct from ones it judged not notable. */
  triageFailedClosed: number | null;
  /** null = ranking was never attempted; false = attempted and failed open. */
  rankApplied: boolean | null;
  /**
   * The same map `usage.report()` was given. Not stored on the record — it
   * is an input to `isFloor`, and keeping the derived verdict rather than the
   * raw expectation is what lets a consumer act on one boolean instead of
   * re-deriving the comparison and getting it subtly different.
   */
  expectedCalls: Partial<Record<UsageStage, number>>;
}

/** One (stage, model) group, flattened out of `StageTotals`'s nested cost. */
export interface UsageRunStage {
  stage: UsageStage;
  model: TrackedModel;
  calls: number;
  callsWithoutUsage: number;
  tokens: CallTokens;
  billedUsd: number;
  listUsd: number;
  /** False when this model had no usable pricing entry — its dollars are unknown, not zero. */
  priced: boolean;
}

export interface UsageRunRecord extends Omit<UsageRunContext, "expectedCalls"> {
  /** Bumped only on a breaking change to this shape. Readers must check it. */
  schemaVersion: 1;
  /** `crypto.randomUUID()`, supplied by the caller — this module stays pure. */
  runId: string;
  /**
   * The collector's fixed `at`, i.e. the instant this run was PRICED, not
   * when the row was written.
   *
   * Null exactly when `clockUsable` is false: an Invalid Date has no ISO
   * form, and inventing one (write time, epoch) would put a fabricated
   * instant on a money row. A consumer that needs a date must exclude these
   * rows, which is the honest outcome — a run whose clock was unusable
   * cannot be placed in a time window at all.
   */
  pricedAtIso: string | null;
  totalCalls: number;
  totalCallsWithoutUsage: number;
  totalTokens: CallTokens;
  totalBilledUsd: number;
  totalListUsd: number;
  /**
   * The machine-readable form of the console summary's FLOOR warnings: the
   * dollar totals on this row are a LOWER BOUND, not the spend.
   *
   * **Anything averaging these rows must exclude the ones where this is
   * true.** That is the whole reason the field exists — a floor run averaged
   * into a trend line drags it down by an unknown amount and leaves no trace
   * that it did.
   */
  isFloor: boolean;
  /** Models present in this run that could not be priced at all. */
  unpricedModels: TrackedModel[];
  /** False when `at` was an Invalid Date, so no promotional window could be confirmed. */
  clockUsable: boolean;
  /** `PRICING_VERIFIED_ON` at emit time — the row's own staleness stamp. */
  pricingVerifiedOn: string;
  stages: UsageRunStage[];
}

/** A record with the user identifier removed. What the JSONL file holds. */
export type PublicUsageRunRecord = Omit<UsageRunRecord, "userId">;

/**
 * Whether any stage billed calls the collector never saw.
 *
 * Deliberately the same comparison `formatUsageSummary` makes — summed
 * across every (stage, model) group for the stage, counting usage-less calls
 * as calls — so the row and the console line can never disagree about
 * whether a run under-recorded. Only the `actual < expected` direction is a
 * floor: MORE calls than expected is a retry, which is real spend that WAS
 * recorded.
 */
function hasUnderRecordedStage(
  summary: UsageSummary,
  expectedCalls: Partial<Record<UsageStage, number>>
): boolean {
  for (const [stage, expected] of Object.entries(expectedCalls)) {
    if (expected === undefined) continue;
    const actual = summary.stages
      .filter((group) => group.stage === stage)
      .reduce((sum, group) => sum + group.calls + group.callsWithoutUsage, 0);
    if (actual < expected) return true;
  }
  return false;
}

/**
 * Assembles the durable record. Pure: `at` and `runId` are injected the same
 * way `usage.ts` injects its clock and its pricing table.
 *
 * Copies every array and token object out of `summary` rather than aliasing
 * them. The collector hands out frozen records, but `summarizeUsage` builds
 * fresh mutable aggregates, and a record that shared them would change under
 * a later reader.
 */
export function buildUsageRunRecord(
  summary: UsageSummary,
  context: UsageRunContext,
  at: Date,
  runId: string
): UsageRunRecord {
  const { expectedCalls, ...rest } = context;

  // isFloor is the OR of all three causes, and each is independently
  // sufficient. Non-obvious one: an unpriced model contributes real tokens
  // and $0.000000 to the totals, because there is no honest number to
  // substitute — so a consumer reading only `totalBilledUsd` is misled with
  // nothing in the number itself to warn them. That is what this flag is for.
  const isFloor =
    summary.totalCallsWithoutUsage > 0 ||
    summary.unpricedModels.length > 0 ||
    hasUnderRecordedStage(summary, expectedCalls);

  return {
    ...rest,
    schemaVersion: 1,
    runId,
    // getTime() on an Invalid Date is NaN, and toISOString() would throw a
    // RangeError. This runs in a route's finally block, so a throw here would
    // surface as a pipeline failure caused purely by instrumentation.
    pricedAtIso: Number.isFinite(at.getTime()) ? at.toISOString() : null,
    totalCalls: summary.totalCalls,
    totalCallsWithoutUsage: summary.totalCallsWithoutUsage,
    totalTokens: { ...summary.totalTokens },
    totalBilledUsd: summary.totalBilledUsd,
    totalListUsd: summary.totalListUsd,
    isFloor,
    unpricedModels: [...summary.unpricedModels],
    clockUsable: summary.clockUsable,
    pricingVerifiedOn: PRICING_VERIFIED_ON,
    stages: summary.stages.map((group) => ({
      stage: group.stage,
      model: group.model,
      calls: group.calls,
      callsWithoutUsage: group.callsWithoutUsage,
      tokens: { ...group.tokens },
      billedUsd: group.cost.billedUsd,
      listUsd: group.cost.listUsd,
      priced: group.priced,
    })),
  };
}

/**
 * Serialises one record as a JSONL line, **without `userId`**.
 *
 * The JSONL file lives under `notes-logs/`, inside a PUBLIC repo, in a
 * directory whose sibling `(C) COST.md` is committed on purpose. It is
 * gitignored — but **this omission deliberately does not depend on that**:
 * a `.gitignore` is one edit from being
 * wrong again, and a user id in a committed file is not recoverable by
 * deleting it later. Two independent guards, and this is the one that holds
 * without anybody remembering it.
 *
 * The Supabase sink keeps `user_id` — that row is already behind RLS, and the
 * column is what a per-user cap reads.
 *
 * Written out field by field rather than as a spread-and-delete: the
 * `PublicUsageRunRecord` annotation makes a missing field a type error and a
 * re-added `userId` an excess-property error, so the omission is checked at
 * compile time instead of resting on a string literal matching a key.
 *
 * Returns the line WITH its trailing newline. A "line" that a caller has to
 * remember to terminate is a caller that will eventually forget and fuse two
 * records into one unparseable one.
 */
export function toJsonlLine(record: UsageRunRecord): string {
  const line: PublicUsageRunRecord = {
    schemaVersion: record.schemaVersion,
    runId: record.runId,
    route: record.route,
    digestId: record.digestId,
    cardId: record.cardId,
    outcome: record.outcome,
    label: record.label,
    runShape: record.runShape,
    pricedAtIso: record.pricedAtIso,
    topicCount: record.topicCount,
    sourceCount: record.sourceCount,
    articleCount: record.articleCount,
    clusterCount: record.clusterCount,
    clustersAfterDedup: record.clustersAfterDedup,
    notableCount: record.notableCount,
    cardsDroppedByCap: record.cardsDroppedByCap,
    cardsWritten: record.cardsWritten,
    cardsFailed: record.cardsFailed,
    cardFailures: record.cardFailures,
    triageFailedClosed: record.triageFailedClosed,
    rankApplied: record.rankApplied,
    totalCalls: record.totalCalls,
    totalCallsWithoutUsage: record.totalCallsWithoutUsage,
    totalTokens: record.totalTokens,
    totalBilledUsd: record.totalBilledUsd,
    totalListUsd: record.totalListUsd,
    isFloor: record.isFloor,
    unpricedModels: record.unpricedModels,
    clockUsable: record.clockUsable,
    pricingVerifiedOn: record.pricingVerifiedOn,
    stages: record.stages,
  };
  // JSON.stringify escapes control characters inside strings, so a label
  // containing a newline cannot split one record across two lines.
  return JSON.stringify(line) + "\n";
}

/**
 * Every record field, paired with the column it is written to.
 *
 * The `satisfies` is the entire point. It makes this map the ONE place a new
 * field has to be declared: add something to `UsageRunRecord` (or to
 * `UsageRunContext`, which it extends) and this literal stops compiling
 * immediately, because `Record<keyof UsageRunRecord, string>` requires every
 * key. A column that does not correspond to a field is an excess-property
 * error in the same stroke.
 *
 * **Do not replace this with a hand-written row interface.** One that lists
 * the columns independently makes the check two steps: a new field produces NO
 * error until someone also remembers to add the column by hand, and only then
 * does the mapping function complain. One forgotten step and the field
 * silently never reaches the database. Deriving the row type from the record
 * through this map collapses it
 * back to one step, and no step that depends on memory.
 *
 * What it does NOT catch, established by mutation rather than assumed: a
 * field paired with the WRONG column, where the two happen to have compatible
 * types. `[COLUMN_OF.pricedAtIso]: record.outcome` compiles, because
 * `RunOutcome` is assignable to `string | null`. No type can see that error,
 * so it is covered by a test instead — one that walks this map and checks
 * each column carries its own field's value. Exported for that test, and
 * because the field-to-column mapping is a fact a reader of the report
 * generator will want.
 */
export const COLUMN_OF = {
  runId: "id",
  userId: "user_id",
  schemaVersion: "schema_version",
  route: "route",
  digestId: "digest_id",
  cardId: "card_id",
  pricedAtIso: "priced_at",
  outcome: "outcome",
  label: "label",
  runShape: "run_shape",
  topicCount: "topic_count",
  sourceCount: "source_count",
  articleCount: "article_count",
  clusterCount: "cluster_count",
  clustersAfterDedup: "clusters_after_dedup",
  notableCount: "notable_count",
  cardsDroppedByCap: "cards_dropped_by_cap",
  cardsWritten: "cards_written",
  cardsFailed: "cards_failed",
  cardFailures: "card_failures",
  triageFailedClosed: "triage_failed_closed",
  rankApplied: "rank_applied",
  totalCalls: "total_calls",
  totalCallsWithoutUsage: "total_calls_without_usage",
  totalTokens: "total_tokens",
  totalBilledUsd: "total_billed_usd",
  totalListUsd: "total_list_usd",
  isFloor: "is_floor",
  unpricedModels: "unpriced_models",
  clockUsable: "clock_usable",
  pricingVerifiedOn: "pricing_verified_on",
  stages: "stages",
} as const satisfies Record<keyof UsageRunRecord, string>;

/**
 * One `public.usage_runs` row — derived from `UsageRunRecord`, never written
 * out by hand, so it cannot fall behind the record it serialises.
 *
 * This is the same shape of guarantee `toJsonlLine` gets from
 * `PublicUsageRunRecord` (`Omit<UsageRunRecord, "userId">`): both are
 * computed FROM the record, so neither can silently fall behind a field
 * ADDED to it. Each drops exactly what it means to drop and nothing else —
 * `userId` there, the DB-owned `created_at` here — and those omissions are
 * declared, not the result of forgetting.
 * The column names come from `COLUMN_OF` above; the value types come
 * straight from the record, which is what makes a nullable field stay
 * nullable here rather than being re-declared, and possibly re-declared
 * wrong.
 */
export type UsageRunRow = {
  [K in keyof UsageRunRecord as (typeof COLUMN_OF)[K]]: UsageRunRecord[K];
};

/**
 * Maps the record onto `public.usage_runs`' column names.
 *
 * Numbers are passed through as numbers, not pre-rounded strings. The dollar
 * columns are `numeric(12,6)` in `supabase/schema.sql`'s `usage_runs` block,
 * so Postgres does the rounding; rounding here as well would mean two
 * roundings, and the JSONL and the table would stop agreeing on the same
 * run's cost — the one cross-check this design has.
 *
 * That file is applied BY HAND in the Supabase SQL editor — there is no
 * migration tool here — so it describes the LIVE table only as far as the
 * last paste. The `usage_runs` block is new, so until it has been pasted once
 * every Supabase insert fails and `emitUsageRun` swallows it; the JSONL sink
 * is unaffected, which is exactly the asymmetry to expect if one sink's rows
 * are missing.
 */
export function toUsageRunRow(record: UsageRunRecord): UsageRunRow {
  return {
    [COLUMN_OF.runId]: record.runId,
    [COLUMN_OF.userId]: record.userId,
    [COLUMN_OF.schemaVersion]: record.schemaVersion,
    [COLUMN_OF.route]: record.route,
    [COLUMN_OF.digestId]: record.digestId,
    [COLUMN_OF.cardId]: record.cardId,
    [COLUMN_OF.pricedAtIso]: record.pricedAtIso,
    [COLUMN_OF.outcome]: record.outcome,
    [COLUMN_OF.label]: record.label,
    [COLUMN_OF.runShape]: record.runShape,
    [COLUMN_OF.topicCount]: record.topicCount,
    [COLUMN_OF.sourceCount]: record.sourceCount,
    [COLUMN_OF.articleCount]: record.articleCount,
    [COLUMN_OF.clusterCount]: record.clusterCount,
    [COLUMN_OF.clustersAfterDedup]: record.clustersAfterDedup,
    [COLUMN_OF.notableCount]: record.notableCount,
    [COLUMN_OF.cardsDroppedByCap]: record.cardsDroppedByCap,
    [COLUMN_OF.cardsWritten]: record.cardsWritten,
    [COLUMN_OF.cardsFailed]: record.cardsFailed,
    [COLUMN_OF.cardFailures]: record.cardFailures,
    [COLUMN_OF.triageFailedClosed]: record.triageFailedClosed,
    [COLUMN_OF.rankApplied]: record.rankApplied,
    [COLUMN_OF.totalCalls]: record.totalCalls,
    [COLUMN_OF.totalCallsWithoutUsage]: record.totalCallsWithoutUsage,
    [COLUMN_OF.totalTokens]: record.totalTokens,
    [COLUMN_OF.totalBilledUsd]: record.totalBilledUsd,
    [COLUMN_OF.totalListUsd]: record.totalListUsd,
    [COLUMN_OF.isFloor]: record.isFloor,
    [COLUMN_OF.unpricedModels]: record.unpricedModels,
    [COLUMN_OF.clockUsable]: record.clockUsable,
    [COLUMN_OF.pricingVerifiedOn]: record.pricingVerifiedOn,
    [COLUMN_OF.stages]: record.stages,
  };
}
