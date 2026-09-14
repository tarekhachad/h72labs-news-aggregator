/**
 * Token-usage accounting and cost arithmetic for this app's Claude API calls.
 *
 * Exists because until the Final Phase this app had no idea what it cost to
 * run. The only figures anywhere were two manual readings off the Anthropic
 * Console, and they disagreed with `(C) ARCHITECTURE.md`'s own account of
 * which pipeline step is expensive. A single console total can't settle that
 * — you need per-stage attribution, which means reading `response.usage` at
 * each call site and pricing it here.
 *
 * The bar this module is held to: **a confidently-wrong number is worse than
 * a crash.** Its output corrects the cost figures in the design docs and
 * sizes the spend caps in V2.0, so anything it can't measure must be visibly
 * unmeasured rather than quietly counted as zero. Every "return null instead
 * of a plausible number" decision below comes from that.
 *
 * Deliberately pure: no I/O, no SDK import, no Node API, no clock. Every
 * function that needs "now" takes an explicit `at: Date`. That's what makes
 * the introductory-pricing boundary testable at the exact second it flips
 * rather than only on the day it happens to be run.
 *
 * The impure half — capturing usage from live calls — lives in
 * `usageCollector.ts`, which imports this and nothing else.
 */

/** The models this app actually calls. Anything else can't be priced. */
export const TRACKED_MODELS = ["claude-haiku-4-5", "claude-sonnet-5"] as const;

export type TrackedModel = (typeof TRACKED_MODELS)[number];

/** The pipeline step a billed call belongs to. */
export type UsageStage = "triage" | "dedup" | "writeCard" | "rank" | "expand";

/** Per-MTok rates, plus the multipliers cached tokens bill at. */
export interface Rate {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache reads bill at ~0.1x the input rate. */
  cacheReadMultiplier: number;
  /** 5-minute-TTL cache writes bill at 1.25x the input rate (1h TTL would be 2x). */
  cacheWriteMultiplier: number;
}

export interface ModelPricing {
  /** What this model costs once every promotion has ended — the rate that survives. */
  list: Rate;
  /**
   * A time-limited promotional rate, when one is running. A closed window:
   * `fromUtcDate` and `throughUtcDate` are the FIRST and LAST days it
   * applies, both inclusive, as YYYY-MM-DD UTC date strings.
   *
   * The window is closed at both ends rather than just capped, so that an
   * implausible date can't quietly earn a discount. An open-ended start
   * would price a call dated 1970 at the promotional rate and report
   * billed < list with nothing flagged — a figure below the real bill, which
   * is the one thing this module must never produce silently.
   *
   * Evaluated in UTC against this app's own clock, on the assumption that
   * Anthropic's billing day is also UTC. There's no better source of truth
   * available from in here; stating the assumption beats leaving it implicit,
   * and the only exposure is a few hours either side of a window's edge.
   */
  promo?: { rate: Rate; fromUtcDate: string; throughUtcDate: string };
}

/**
 * Frozen all the way down, for the reason ZERO_TOKENS and every RecordedCall
 * are: this is the money table, exported from a module whose whole claim is
 * that its numbers can be trusted. A consumer reaching in and editing a rate —
 * by accident, in a test that forgets to clean up, or deliberately — would
 * change every subsequent price in the process with nothing to show for it.
 * Object.freeze is shallow, so each nested Rate has to be frozen too.
 *
 * Hand-enumerated rather than a generic deep walk. Precisely what that costs:
 * a new SCALAR field on ModelPricing or Rate is still protected, because the
 * `Object.freeze(entry)` and `Object.freeze(entry.list)` calls below cover
 * every own property of those objects. What is NOT protected is a new NESTED
 * OBJECT — add `{ tiers: {...} }` to ModelPricing and its contents stay
 * writable with nothing here to say so. A recursive walk would close that at
 * the cost of freezing shapes this module does not own. The enumeration is
 * kept because ModelPricing is a two-field type defined ten lines above; if it
 * gains a nested object, this function is the second place to edit.
 */
function deepFreezePricing(
  table: Record<TrackedModel, ModelPricing>
): Record<TrackedModel, ModelPricing> {
  for (const entry of Object.values(table)) {
    Object.freeze(entry.list);
    if (entry.promo !== undefined) {
      Object.freeze(entry.promo.rate);
      Object.freeze(entry.promo);
    }
    Object.freeze(entry);
  }
  return Object.freeze(table);
}

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Nothing in this app sets `cache_control` today, so the cache multipliers are
 * unexercised — they're here so that if prompt caching is ever added, the
 * first run prices it correctly instead of quietly billing cached tokens at
 * the full input rate. (Worth checking before reaching for it: each model
 * has a minimum cacheable prefix length, and Haiku 4.5's is far longer than
 * the triage system prompt — so caching may not be available at all for the
 * highest-volume call site. Confirm against current docs, not this comment.)
 *
 * Note one unverified assumption in that future: the multipliers apply to
 * whichever base rate is active, so during a promo a cached token is priced
 * off the promotional input rate rather than off list. That's the natural
 * reading, but it has never been checked against a real invoice — confirm it
 * before turning caching on, since nothing here would reveal it was wrong.
 *
 * `Record<TrackedModel, ...>` rather than a loose object: adding a model to
 * TRACKED_MODELS without pricing it is then a `tsc` failure, not a runtime
 * surprise at the one moment you're trying to trust the numbers.
 */
export const PRICING: Record<TrackedModel, ModelPricing> = deepFreezePricing({
  "claude-haiku-4-5": {
    list: {
      inputPerMTok: 1.0,
      outputPerMTok: 5.0,
      cacheReadMultiplier: CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
    },
  },
  "claude-sonnet-5": {
    // No promo entry: $2/$10 is Sonnet 5's standard price, not a promotional
    // one. `ModelPricing.promo` stays available but unused, because the
    // alternative way to encode a temporary rate — editing `list` down and back
    // up — under-reports silently, and a figure below the real bill is the one
    // output this module must never produce.
    //
    // Two traps when re-verifying these rates. A dated promo models a
    // SCHEDULED price change, and it expires on schedule whether or not the
    // change actually happens — so a cancelled increase leaves this table
    // over-stating a rate with nothing in the app able to detect it. And
    // $3/$15 is also Sonnet 4.6's rate, so that value appearing here reads like
    // a copy-paste slip from the wrong model when it may not be one.
    list: {
      inputPerMTok: 2.0,
      outputPerMTok: 10.0,
      cacheReadMultiplier: CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
    },
  },
});

/**
 * When the rates above were last checked against Anthropic's published
 * pricing. A promo expiring is self-detecting (it's a date comparison); a
 * change to the *list* price is not detectable from inside this app at all,
 * so the next best thing is printing this in every summary so a stale table
 * is visible rather than silent.
 *
 * Printed on every summary that reports spend — `formatUsageSummary` emits it
 * for any run with recorded calls, and **deliberately not only when a promotion
 * exists**. Gating it on the promo footer would make it disappear the moment
 * the last promo is removed, taking the only staleness signal with it and
 * leaving nothing to notice it had gone. (It is not printed on the two
 * zero-call early returns: those report no cost, so there is no figure whose
 * rates could be stale.)
 *
 * **A per-model rate error and a per-digest error are different numbers and are
 * easy to confuse.** What sets the blended error is each model's share of
 * SPEND, not its share of calls — Haiku dominates the call count far more than
 * it dominates the bill, so a Sonnet-only rate error moves the digest total by
 * much less than it moves the Sonnet line. Quote whichever the claim actually
 * needs; they are not interchangeable.
 *
 * Nothing inside this app can detect a list-price change. Only re-checking the
 * published rates against this date can.
 */
export const PRICING_VERIFIED_ON = "2026-09-11";

/** Billable token counts for one API call. */
export interface CallTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One recorded call. `tokens: null` means it was billed but unmeasurable. */
export interface RecordedCall {
  stage: UsageStage;
  model: TrackedModel;
  tokens: CallTokens | null;
}

export interface CostBreakdown {
  /**
   * Whether a promotional window was CONFIRMED open at the priced instant.
   *
   * Nearly a fact about the rate card rather than this run — but not quite,
   * and the gap matters: an unusable `at` makes `utcDateString` return null
   * and this false, because no window can be confirmed rather than because
   * none was open. False therefore means "not confirmably live", which is the
   * same conservative reading `utcDateString` documents. Use this to describe
   * pricing; use `promoApplied` to describe a discount actually taken.
   */
  promoLive: boolean;
  /** What these tokens actually cost on `at`, promo applied if one was live. */
  billedUsd: number;
  /** What the same tokens cost at list price — i.e. after any promo ends. */
  listUsd: number;
  /** True only when a promo was live on `at` AND actually reduced the price. */
  promoApplied: boolean;
  /** Last day this model's promo applies, or null if it has none. */
  promoEndsOn: string | null;
}

/**
 * Frozen because it's exported and used as the aggregation seed on every
 * `summarizeUsage` call. A caller that assigned it rather than spreading it,
 * then mutated it, would corrupt the starting "zero" for every later run in
 * the process — the same class of shared-object hazard the collector avoids
 * by storing frozen copies.
 */
export const ZERO_TOKENS: Readonly<CallTokens> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/**
 * A token count is a non-negative finite number.
 *
 * This predicate does no normalizing. The `+ 0` that turns -0 into 0 lives in
 * the callers that build CallTokens.
 */
function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Reads an own numeric cache-token property. Absent, null, or undefined
 * means zero — the ordinary case, since the SDK types both cache fields as
 * `number | null` and this app never sets `cache_control`. A *present but
 * invalid* value returns `null`, invalidating the record (see
 * `normalizeUsage`).
 */
function optionalCount(raw: object, key: string): number | null {
  if (!Object.hasOwn(raw, key)) return 0;
  const value = (raw as Record<string, unknown>)[key];
  if (value === null || value === undefined) return 0;
  return isTokenCount(value) ? value + 0 : null;
}

/**
 * Reads an SDK response's `usage` into `CallTokens`.
 *
 * Returns **null**, never a zero-filled `CallTokens`, when usage is missing or
 * unrecognizable — and that one rule explains everything below. Zeros are
 * indistinguishable from a genuinely free call and would silently drag the
 * measured total under the real bill; a null instead routes the call into
 * `callsWithoutUsage`, which prints as a loud warning that the totals are a
 * floor. So anything that can't be trusted invalidates the whole record:
 * a missing or non-numeric `input_tokens`/`output_tokens` (the two fields
 * that make a payload recognizable at all), and a *present but invalid*
 * cache count, including a negative one — a negative would subtract from a
 * total while still looking like measured data.
 *
 * The required fields and the optional cache fields are probed with
 * `Object.hasOwn` rather than plain property
 * access, so a polluted `Object.prototype` can't make an empty object look
 * like real usage. Inherited properties are not this object's usage.
 *
 * The null path is also what keeps the app degrading safely rather than
 * throwing: the existing test suite mocks `messages.parse` with responses
 * that have no `usage` field at all, and those tests pass untouched.
 */
export function normalizeUsage(usage: unknown): CallTokens | null {
  if (usage === null || typeof usage !== "object") return null;

  const raw = usage as object;
  if (!Object.hasOwn(raw, "input_tokens") || !Object.hasOwn(raw, "output_tokens")) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (!isTokenCount(record.input_tokens) || !isTokenCount(record.output_tokens)) {
    return null;
  }

  const cacheReadTokens = optionalCount(raw, "cache_read_input_tokens");
  const cacheWriteTokens = optionalCount(raw, "cache_creation_input_tokens");
  if (cacheReadTokens === null || cacheWriteTokens === null) return null;

  return {
    // `+ 0` normalizes -0 to 0, so a signed zero can't reach a total.
    inputTokens: record.input_tokens + 0,
    outputTokens: record.output_tokens + 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function addTokens(a: CallTokens, b: CallTokens): CallTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

function applyRate(tokens: CallTokens, rate: Rate): number {
  const inputUsd =
    tokens.inputTokens * rate.inputPerMTok +
    tokens.cacheWriteTokens * rate.inputPerMTok * rate.cacheWriteMultiplier +
    tokens.cacheReadTokens * rate.inputPerMTok * rate.cacheReadMultiplier;
  const outputUsd = tokens.outputTokens * rate.outputPerMTok;
  return (inputUsd + outputUsd) / 1_000_000;
}

/**
 * The UTC calendar date of `at` as YYYY-MM-DD, or null if `at` isn't a usable
 * date.
 *
 * The null case matters more than it looks: `toISOString()` throws
 * `RangeError` on an Invalid Date, so a bad clock would otherwise crash the
 * whole cost report rather than degrade it. Returning null instead lets the
 * callers treat it as "no promo can be confirmed live", which prices at list.
 *
 * Note what that does and does not guarantee. For a promo cheaper than list —
 * every real one so far — pricing at list overstates, which is the safe
 * direction. For a promo priced ABOVE list it understates, and this module
 * refuses to assume promos are discounts anywhere else (the footer carries a
 * surcharge branch precisely because they need not be). So: list is the safe
 * fallback in the usual case, not an unconditional floor.
 *
 * Three callers. promoLiveAt and promoWindowStateAt reach it only for models
 * that carry a promo; summarizeUsage calls it unconditionally to set
 * `clockUsable`. That last one is why an unusable instant is detected at run
 * level regardless of which models appear — the property the earlier version
 * of this comment wanted and described incorrectly. (It claimed the
 * guard averted a "data-dependent landmine" firing only on promoted models;
 * at the time costFor called this unconditionally, so the landmine it argued
 * against did not exist.)
 */
function utcDateString(at: Date): string | null {
  const time = at.getTime();
  if (!Number.isFinite(time)) return null;
  return at.toISOString().slice(0, 10);
}

/**
 * Whether `today` falls inside a promo's closed window.
 *
 * String comparison is safe and intended: both sides are zero-padded
 * YYYY-MM-DD, so lexicographic order is chronological order. Both ends are
 * inclusive — the rate applies through the whole of its first and last days.
 */
function isWithinPromo(today: string, promo: NonNullable<ModelPricing["promo"]>): boolean {
  return today >= promo.fromUtcDate && today <= promo.throughUtcDate;
}

/**
 * Whether `promo`'s window is confirmed open at `at`.
 *
 * Extracted so `costFor` and `summarizeUsage`'s promo footer share one
 * implementation. They must agree, and the arrangement that shipped instead
 * failed: having the footer read `costFor`'s output made a fact about
 * Anthropic's rate card depend on a computation that throws for an
 * unpriceable model, so a live promo on a malformed entry reported as "not in
 * effect for this run". The other candidate — writing the date check out in
 * both places — was rejected rather than tried, on the grounds that two
 * copies of the same predicate drift.
 *
 * Whether a promotional window is open is a property of the rate card and the
 * clock. It is knowable even when the spend is not, and this is the only
 * place that decides it.
 */
function promoLiveAt(promo: ModelPricing["promo"], at: Date): boolean {
  if (promo === undefined) return false;
  const today = utcDateString(at);
  return today !== null && isWithinPromo(today, promo);
}

/**
 * Which of the four window states `promo` is in at `at`.
 *
 * Split out from `promoLiveAt` rather than folded into it because the boolean
 * is what pricing needs and the reason is what the log needs. Both read the
 * same clock and the same dates; neither infers the other.
 */
function promoWindowStateAt(
  promo: NonNullable<ModelPricing["promo"]>,
  at: Date
): PromoWindowState {
  const today = utcDateString(at);
  if (today === null) return "unknown";
  if (isWithinPromo(today, promo)) return "open";
  // String comparison is safe and intended here: these are zero-padded ISO
  // dates, so lexical order is chronological order. Same assumption
  // isWithinPromo makes.
  return today < promo.fromUtcDate ? "notYetOpen" : "ended";
}

/**
 * Prices `tokens` both ways: what they cost on `at`, and what they cost at
 * list. Both figures are always returned — reporting only the billed number
 * bakes a temporary discount into a document that outlives it, and reporting
 * only list misstates what the card was actually charged.
 *
 * The promo is a date gate, not a swapped-in table, so it expires on its own:
 * past `throughUtcDate` the comparison simply stops matching, `promoApplied`
 * goes false, and `billedUsd === listUsd` with no code change.
 *
 * `table` defaults to the real pricing table and exists so the promo machinery
 * can be tested against a fixture. That is not a test-only convenience: when
 * Sonnet 5's promo was removed in Sep 2026, a *correct* pricing update broke
 * ten *correct* tests, because they could only reach the promo path through
 * whatever Anthropic happened to charge that month. Injecting the table
 * decouples the two permanently — the next introductory rate costs one
 * fixture entry, not a test rewrite. Same shape as the `at: Date` injection
 * this module already made its signature feature.
 */
export function costFor(
  model: TrackedModel,
  tokens: CallTokens,
  at: Date,
  table: Record<TrackedModel, ModelPricing> = PRICING
): CostBreakdown {
  // Indexed here rather than taken pre-resolved. Accepting a bare
  // ModelPricing would leave `model` unused whenever a caller passed one,
  // so costFor("claude-haiku-4-5", t, at, PRICING["claude-sonnet-5"]) would
  // type-check and return a confidently-wrong number — the exact output this
  // module exists to prevent. Taking the whole table makes the mismatch
  // inexpressible, and gives summarizeUsage and costFor one shared lookup
  // path instead of two that can disagree.
  // Object.hasOwn, not `table[model] === undefined`, for the same reason
  // normalizeUsage checks its payload with it: a rate inherited from
  // Object.prototype is an attacker- or accident-supplied number on the money
  // path, and `in`/plain indexing would accept it. A null entry has to be
  // rejected here too — `=== undefined` sails straight past it and the next
  // line dies on `null.list`.
  const pricing = Object.hasOwn(table, model) ? table[model] : undefined;
  if (pricing === null || typeof pricing !== "object") {
    // Named, because the nearest caller is report(), which swallows. A bare
    // TypeError there is indistinguishable from a run that made no calls.
    throw new Error(`costFor: no pricing entry for model ${model}`);
  }
  const listUsd = applyRate(tokens, pricing.list);

  const promo = pricing.promo;
  const promoLive = promoLiveAt(promo, at);
  // The `promo !== undefined` is narrowing for the type checker, not a second
  // liveness test — promoLiveAt already returns false when promo is undefined.
  const billedUsd = promoLive && promo !== undefined ? applyRate(tokens, promo.rate) : listUsd;

  return {
    billedUsd,
    listUsd,
    // Two separate facts, deliberately not one boolean.
    //
    // `promoLive` is about the WORLD: was a promotional window open at `at`.
    // `promoApplied` is about THIS SPEND: did that window actually reduce it.
    // They come apart whenever the tokens are zero — a stage whose calls all
    // reported no usage aggregates to nothing, and `0 < 0` is false. Reporting
    // "the promo is not in effect" for such a run states something false about
    // Anthropic's pricing on the strength of this app failing to read a usage
    // payload. They also come apart if a promo is ever priced at or above list.
    promoLive,
    promoApplied: promoLive && billedUsd < listUsd,
    promoEndsOn: promo?.throughUtcDate ?? null,
  };
}

export interface StageTotals {
  stage: UsageStage;
  model: TrackedModel;
  /** Calls whose usage was actually recorded. */
  calls: number;
  /** Calls that were billed (or may have been) but reported no usage. */
  callsWithoutUsage: number;
  tokens: CallTokens;
  cost: CostBreakdown;
  /**
   * False when this group's model had no usable pricing entry, so `cost` is
   * zeros that mean "unknown" rather than "free".
   *
   * Note what this does NOT do: the group's tokens still count toward
   * `totalTokens`, and its zero dollars still sum into `totalBilledUsd` /
   * `totalListUsd`. Nothing is excluded — there is no honest number to
   * substitute, so the zeros stay and `unpricedModels` plus the formatter's
   * FLOOR warning are what stop them being read as a complete figure. A
   * consumer reading a dollar total without checking `unpricedModels` will be
   * misled; that is why the field exists. The alternative — throwing out of
   * summarizeUsage — would take the entire run's report with it, including the
   * stages that priced perfectly well, and since report() swallows, the result
   * is silence that reads exactly like a free run.
   * Destroying correct numbers to avoid one unknown one is the wrong trade for
   * a module whose job is cost visibility.
   */
  priced: boolean;
}

/**
 * Why a promotional window is or is not in effect — the distinction `applied`
 * alone cannot carry.
 *
 * `applied: false` has three causes that mean different things, and collapsing
 * them produced the fifth false footer: a promo whose `fromUtcDate` had not
 * arrived was reported as having "ended", naming a date in the future. This is
 * a small, deliberate step toward making that class of bug unrepresentable —
 * a named state rendered by exhaustive cases rather than inferred from a
 * boolean and the order of some if/elses.
 */
export type PromoWindowState =
  /** Confirmed open at the priced instant. */
  | "open"
  /** Confirmed shut because `throughUtcDate` has passed. */
  | "ended"
  /** Confirmed shut because `fromUtcDate` has not arrived. */
  | "notYetOpen"
  /** Could not be evaluated — the priced instant was unusable. */
  | "unknown";

export interface PromoNotice {
  /**
   * Which of the three reasons `applied` holds the value it does. Render from
   * this, never from `applied` plus an assumption about why.
   */
  windowState: PromoWindowState;
  /**
   * Whether every stage of this model priced successfully.
   *
   * Asked FIRST in the footer, because it gates every money claim. Ordering it
   * anywhere else produced the fourth false-footer bug: an unpriceable model
   * under an unusable clock matched the clock branch and printed "pricing fell
   * back to list, which can overstate but never understate" — this module's
   * headline guarantee, asserted in the single state where it does not hold,
   * because costFor had thrown and the figure was a placeholder.
   */
  priced: boolean;
  /**
   * Whether this model had any priced, non-zero spend to compare at all.
   *
   * Without it, `discounted: false` conflates "the promo was not cheaper" with
   * "we had nothing to measure". Zero tokens make billed and list both 0, so
   * `billed < list` is false — and a run whose calls all reported unreadable
   * usage would be told its 33%-cheaper promo was NOT cheaper than list. That
   * is a false claim about Anthropic's rate card sourced from nothing more than
   * this app failing to parse a usage payload.
   */
  measurable: boolean;
  /**
   * Whether the promotional rate actually reduced this model's spend.
   *
   * Distinct from `applied`, which is about the rate card rather than this
   * run, and only meaningful once `measurable` is true — with nothing to
   * price, `billed < list` is false for reasons that say nothing about the
   * promo. The trio exists because every smaller encoding put a false
   * statement in the log: a date-only `applied` announced a discount for a
   * promo priced ABOVE list; a spend-only `applied` announced "not in effect"
   * during a live promo; and the two-flag version announced a 33%-cheaper
   * promo as NOT cheaper. See formatUsageSummary's footer for the branches.
   */
  discounted: boolean;
  /**
   * True only if every one of this model's stages was priceable AND charged at
   * its list rate.
   *
   * Consumed only by the footer today — no production code branches on it, and
   * the routes never read a PromoNotice at all. It is a rendering input, not a
   * pricing input; if that ever stops being true, revisit whether a field this
   * heavily conditioned belongs in the summary or in the formatter. False covers three different situations — a live discount,
   * a promo dearer than list, and a stage that could not be priced at all — so
   * it is never the negation of `applied` and must not be used as one. The
   * `priced` guard matters: an unpriced group's cost is a zero seed, and
   * `0 === 0` would otherwise report an UNKNOWN cost as list price.
   */
  billedAtList: boolean;
  model: TrackedModel;
  endsOn: string;
  /**
   * Whether the promotional rate was actually in effect for this run.
   *
   * A boolean "was it applied" rather than "has it expired", because a promo
   * can fail to apply for more than one reason — the run predates the
   * window, or the clock was unusable — and a footer that says "ended" in
   * those cases would be stating something false.
   */
  applied: boolean;
}

export interface UsageSummary {
  /**
   * Models present in this run that could not be priced. Non-empty means the
   * dollar totals below are a FLOOR — some real spend is missing from them.
   */
  unpricedModels: TrackedModel[];
  /**
   * Whether the priced instant was usable at all. False means `at` was an
   * Invalid Date, so NO promotional window could be confirmed for any model
   * and everything fell back to list.
   *
   * Needed because `applied: false` otherwise reads as "the promo was not
   * running", which is a claim about Anthropic's rate card. With an unusable
   * clock the honest statement is that nothing could be determined — a
   * distinction `utcDateString` already makes and the footer was flattening.
   */
  clockUsable: boolean;
  /** Grouped by the (stage, model) pair — see `summarizeUsage`. */
  stages: StageTotals[];
  totalCalls: number;
  totalCallsWithoutUsage: number;
  totalTokens: CallTokens;
  totalBilledUsd: number;
  totalListUsd: number;
  /**
   * One entry per model in this run that has a promo, live or lapsed. A list
   * rather than a single field so a second promoted model can't be silently
   * dropped from the footer; only Sonnet has one today.
   */
  promos: PromoNotice[];
}

/**
 * Aggregates recorded calls into per-stage totals.
 *
 * Grouped by the **(stage, model) pair**, not by stage alone. This is not
 * defensive futureproofing — **a stage already mixes models today.**
 * `modelForCluster` in writeCard.ts routes single-article clusters to Haiku
 * and multi-source ones to Sonnet, so a single run's writeCard stage routinely
 * emits both. Summing that stage's tokens and pricing them once would be wrong
 * by up to 2x — Sonnet bills 2x Haiku on both input and output — and wrong
 * quietly. Grouping on the pair makes that structurally impossible, so do not
 * collapse it on the assumption that a stage uses one model.
 */
export function summarizeUsage(
  calls: RecordedCall[],
  at: Date,
  table: Record<TrackedModel, ModelPricing> = PRICING
): UsageSummary {
  const groups = new Map<string, StageTotals>();

  for (const call of calls) {
    const key = `${call.stage} ${call.model}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        stage: call.stage,
        model: call.model,
        calls: 0,
        callsWithoutUsage: 0,
        tokens: { ...ZERO_TOKENS },
        cost: {
          billedUsd: 0,
          listUsd: 0,
          promoLive: false,
          promoApplied: false,
          promoEndsOn: null,
        },
        priced: true,
      };
      groups.set(key, group);
    }

    if (call.tokens === null) {
      group.callsWithoutUsage += 1;
    } else {
      group.calls += 1;
      group.tokens = addTokens(group.tokens, call.tokens);
    }
  }

  const stages = [...groups.values()];
  for (const group of stages) {
    try {
      group.cost = costFor(group.model, group.tokens, at, table);
    } catch {
      // Per-group, so one unpriceable model costs this stage's figure and
      // nothing else. The zeros left in `cost` are flagged by `priced: false`
      // and forced into the FLOOR warning by the formatter — they are never
      // presented as a real total.
      group.priced = false;
    }
  }

  const unpricedModels = [...new Set(stages.filter((g) => !g.priced).map((g) => g.model))];
  const clockUsable = utcDateString(at) !== null;

  const promos: PromoNotice[] = [];
  for (const model of new Set(stages.map((group) => group.model))) {
    const promo = Object.hasOwn(table, model) ? table[model]?.promo : undefined;
    if (promo !== undefined) {
      const forModel = stages.filter((group) => group.model === model);
      promos.push({
        model,
        endsOn: promo.throughUtcDate,
        // From the table and the clock via promoLiveAt — the same predicate
        // costFor calls, so the two cannot disagree.
        //
        // NOT read off `forModel`'s costs. That was tried and it was a bug: an
        // unpriceable group keeps its zero seed, whose promoLive is false, so
        // a live promo on a malformed entry was announced as "not in effect".
        // NOT re-derived inline either — two copies of the date check drift.
        // If you are about to change this line, those are the two failures it
        // already sits between.
        // Read off forModel's per-group results — correct here, because
        // whether every stage priced IS a fact about this run's arithmetic.
        priced: forModel.every((group) => group.priced),
        // The next two come from the table and the clock via shared
        // predicates, NOT from forModel's costs. Reading `applied` off the
        // costs was a bug: an unpriceable group keeps a zero seed whose
        // promoLive is false, so a live promo on a malformed entry was
        // announced as "not in effect". Re-deriving the date check inline
        // instead would be a second copy that drifts. If you are about to
        // change either of these two lines, those are the failures they sit
        // between.
        windowState: promoWindowStateAt(promo, at),
        applied: promoLiveAt(promo, at),
        discounted: forModel.some((group) => group.cost.promoApplied),
        // The `priced &&` is currently redundant and deliberately kept: an
        // unpriced group keeps its zero seed, so `listUsd > 0` is already
        // false for it. Mutation testing confirms removing it changes no
        // observable behaviour — do not spend a round writing a test for it.
        // It stays because it states the intent (an unpriceable group has
        // nothing to measure, not a measured zero) and because that stops
        // being redundant the moment the seed or the catch changes.
        measurable: forModel.some((group) => group.priced && group.cost.listUsd > 0),
        // Whether this model's spend was genuinely charged at list. Not the
        // negation of `applied`: a promo dearer than list is neither applied
        // nor billed at list, and the footer must not claim it was.
        billedAtList: forModel.every(
          (group) => group.priced && group.cost.billedUsd === group.cost.listUsd
        ),
      });
    }
  }

  return {
    stages,
    totalCalls: stages.reduce((sum, g) => sum + g.calls, 0),
    totalCallsWithoutUsage: stages.reduce((sum, g) => sum + g.callsWithoutUsage, 0),
    totalTokens: stages.reduce((sum, g) => addTokens(sum, g.tokens), { ...ZERO_TOKENS }),
    totalBilledUsd: stages.reduce((sum, g) => sum + g.cost.billedUsd, 0),
    totalListUsd: stages.reduce((sum, g) => sum + g.cost.listUsd, 0),
    unpricedModels,
    clockUsable,
    promos,
  };
}

/**
 * The smallest cost `formatUsd` can render without rounding it away.
 *
 * Exported so `costReport.ts`'s table cells can hold the same line as
 * `formatUsd` does. They render differently — the table omits the `$` because
 * its row label carries the unit — but they must agree on WHEN a figure is too
 * small to print, or the same report says `<$0.000001` in prose and
 * `0.000000` in a table for one number. That happened, and a second literal is
 * what made it possible.
 */
export const SMALLEST_SHOWN_USD = 0.000001;

/**
 * Six decimal places: a single Haiku triage call costs around $0.0015.
 *
 * A nonzero cost too small to render is shown as "<$0.000001" rather than
 * "$0.000000", so a line can never claim something was free when it wasn't.
 */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < SMALLEST_SHOWN_USD) return `<$${SMALLEST_SHOWN_USD.toFixed(6)}`;
  return `$${usd.toFixed(6)}`;
}

/**
 * Exported so every line this subsystem emits — including usageCollector's
 * report-failure diagnostic, which is written on a different stream — carries
 * the same prefix. `grep '\[usage\]'` over a log is the intended way to pull
 * a run's cost story out, and a second literal would drift out of it silently.
 */
export const LOG_PREFIX = "[usage]";

/** One line per API call, emitted as the call completes. */
export function formatCallLine(
  call: RecordedCall,
  at: Date,
  table: Record<TrackedModel, ModelPricing> = PRICING
): string {
  if (call.tokens === null) {
    return `${LOG_PREFIX} ${call.stage} ${call.model} — no usage reported (billed amount unknown)`;
  }
  const t = call.tokens;
  const cost = costFor(call.model, t, at, table);
  return (
    `${LOG_PREFIX} ${call.stage} ${call.model} in=${t.inputTokens} out=${t.outputTokens} ` +
    `cache_r=${t.cacheReadTokens} cache_w=${t.cacheWriteTokens} ${formatUsd(cost.billedUsd)}`
  );
}

export interface SummaryOptions {
  /** e.g. "digest complete" / "expand complete". */
  label: string;
  /**
   * How many calls each stage was expected to make, where the caller knows —
   * e.g. `{ writeCard: 5 }` when the run produced 5 cards. Compared in both
   * directions, because each mismatch means something different and both are
   * invisible in the totals: more calls than expected means extra billed
   * attempts (the ambiguous-truncation retry in `claudeText.ts` bills twice
   * for one card), and fewer means calls that were billed but never recorded
   * — a confidently-low number, the failure this module most needs to catch.
   */
  expectedCalls?: Partial<Record<UsageStage, number>>;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function padStart(value: string, width: number): string {
  return value.padStart(width);
}

/** Renders a call count, showing unmeasured calls rather than hiding them. */
function formatCallCount(calls: number, callsWithoutUsage: number): string {
  return callsWithoutUsage > 0 ? `${calls}+${callsWithoutUsage}?` : String(calls);
}

/**
 * Renders the summary as console lines. Returns an array rather than one
 * blob so the caller emits one `console.log` per line (keeping each line
 * individually greppable) and tests can assert on lines rather than on
 * whitespace.
 */
export function formatUsageSummary(summary: UsageSummary, opts: SummaryOptions): string[] {
  const lines: string[] = [];
  const totalRecorded = summary.totalCalls + summary.totalCallsWithoutUsage;
  const expectedCalls = opts.expectedCalls ?? {};

  if (totalRecorded === 0) {
    const expectedTotal = Object.values(expectedCalls).reduce<number>(
      (sum, n) => sum + (n ?? 0),
      0
    );
    if (expectedTotal > 0) {
      lines.push(
        `${LOG_PREFIX} WARNING: ${opts.label} — expected ${expectedTotal} Claude call(s) but recorded 0. ` +
          `Instrumentation is not wired up; this run's real cost is unknown.`
      );
    } else {
      lines.push(`${LOG_PREFIX} ${opts.label} — 0 calls. No Claude spend this run.`);
    }
    return lines;
  }

  lines.push(`${LOG_PREFIX} ${opts.label} — ${totalRecorded} calls`);
  lines.push(
    `${LOG_PREFIX}   ${pad("stage", 11)}${padStart("calls", 6)}  ${pad("model", 18)}` +
      `${padStart("input", 8)}${padStart("output", 8)}${padStart("cache_r", 9)}${padStart("cache_w", 9)}` +
      `${padStart("billed", 13)}${padStart("at list", 13)}`
  );

  const row = (
    stage: string,
    calls: string,
    model: string,
    t: CallTokens,
    billed: number,
    list: number
  ) =>
    `${LOG_PREFIX}   ${pad(stage, 11)}${padStart(calls, 6)}  ${pad(model, 18)}` +
    `${padStart(String(t.inputTokens), 8)}${padStart(String(t.outputTokens), 8)}` +
    `${padStart(String(t.cacheReadTokens), 9)}${padStart(String(t.cacheWriteTokens), 9)}` +
    `${padStart(formatUsd(billed), 13)}${padStart(formatUsd(list), 13)}`;

  for (const stage of summary.stages) {
    lines.push(
      row(
        stage.stage,
        formatCallCount(stage.calls, stage.callsWithoutUsage),
        stage.model,
        stage.tokens,
        stage.cost.billedUsd,
        stage.cost.listUsd
      )
    );
  }

  lines.push(
    row(
      "TOTAL",
      formatCallCount(summary.totalCalls, summary.totalCallsWithoutUsage),
      "",
      summary.totalTokens,
      summary.totalBilledUsd,
      summary.totalListUsd
    )
  );

  if (summary.unpricedModels.length > 0) {
    // Ahead of the usage-less warning: a model with no pricing entry is a
    // configuration fault, not a flaky API response, and it is the more
    // actionable of the two. Its rows show $0.000000 in the table above — the
    // one place a zero here does not mean free — so this line has to be
    // unmissable.
    lines.push(
      `${LOG_PREFIX} WARNING: could not price ${summary.unpricedModels.join(", ")} — ` +
        `those rows are shown at $0.000000 because their cost is UNKNOWN, not because they ` +
        `were free. Every total here is a FLOOR. Check that model's entry in PRICING ` +
        `(usage.ts): it is missing, or present but malformed.`
    );
  }

  if (summary.totalCallsWithoutUsage > 0) {
    lines.push(
      `${LOG_PREFIX} WARNING: ${summary.totalCallsWithoutUsage} call(s) reported no usage ` +
        `(shown as "+N?" above) — every total here is a FLOOR, not the real spend.`
    );
  }

  for (const [stage, expected] of Object.entries(expectedCalls)) {
    if (expected === undefined) continue;
    // Summed across every group for this stage, not just the first match.
    // `summarizeUsage` splits a stage by model on purpose; a consumer that
    // read only one group would report a call count that silently excluded
    // the rest.
    const groups = summary.stages.filter((s) => s.stage === stage);
    const actual = groups.reduce((sum, g) => sum + g.calls + g.callsWithoutUsage, 0);

    if (actual > expected) {
      lines.push(
        `${LOG_PREFIX} ${stage} made ${actual} calls for ${expected} — ` +
          `${actual - expected} extra billed attempt(s) (truncation retry and/or a failed item).`
      );
    } else if (actual < expected) {
      lines.push(
        `${LOG_PREFIX} WARNING: ${stage} recorded ${actual} calls but ${expected} were expected — ` +
          `${expected - actual} billed call(s) went unrecorded, so this total is a FLOOR.`
      );
    }
  }

  for (const promo of summary.promos) {
    // Six branches over five flags, because every attempt to serve them from
    // fewer has put a false statement in this log. In order of discovery: a
    // date-only `applied` called a SURCHARGE a discount; a spend-only
    // `applied` called a LIVE promo expired; collapsing "not cheaper" with
    // "nothing to measure" called a 33%-cheaper promo NOT cheaper; and reading
    // `applied` off the per-group costs called a live promo "not in effect"
    // whenever the model could not be priced.
    //
    // Those last three share one root cause: a fact about Anthropic's RATE
    // CARD was being inferred from THIS RUN's arithmetic, which can be zero or
    // can fail. `measurable` therefore has to be asked before `discounted`
    // means anything, and `applied` comes from the table and the clock alone.
    if (!promo.priced) {
      // Priceability first: it is the only fact here that gates the others.
      // Every branch below makes a claim about money, and none of them can be
      // supported when costFor never produced a figure. The window state is
      // still reportable — it comes from the table and the clock, not from the
      // arithmetic — so say what is known and refuse the rest.
      const window =
        promo.windowState === "unknown"
          ? "could not be evaluated (this run's timestamp was unusable)"
          : promo.windowState === "open"
            ? `is in effect (through ${promo.endsOn})`
            : promo.windowState === "notYetOpen"
              ? "has not opened yet"
              : `is not in effect (ended ${promo.endsOn})`;
      lines.push(
        `${LOG_PREFIX} ${promo.model} promotional window ${window}, but its cost could not be ` +
          `established at all — the figures shown for it are placeholders, not a bill. See the ` +
          `pricing warning above.`
      );
    } else if (!summary.clockUsable) {
      // Priced, so the fallback-to-list claim below is actually true.
      lines.push(
        `${LOG_PREFIX} WARNING: ${promo.model} has a promotional window (through ${promo.endsOn}) ` +
          `that could not be evaluated — this run's timestamp was unusable, so it was priced at ` +
          `list. If that window was open, these figures are not the bill: higher if the rate was ` +
          `a discount, lower if it was a surcharge.`
      );
    } else if (promo.applied && !promo.measurable) {
      lines.push(
        `${LOG_PREFIX} ${promo.model} introductory pricing is in effect for this run (through ` +
          `${promo.endsOn}), but nothing priceable was measured for it, so whether it saved ` +
          `anything here cannot be said either way.`
      );
    } else if (promo.applied && promo.discounted) {
      lines.push(
        `${LOG_PREFIX} ${promo.model} introductory pricing was in effect for this run and ends ` +
          `${promo.endsOn} — "at list" is what this same run costs from the day after.`
      );
    } else if (promo.applied) {
      lines.push(
        `${LOG_PREFIX} WARNING: ${promo.model} has a promotional rate in effect for this run ` +
          `(through ${promo.endsOn}) that is NOT cheaper than list. Billed is what it ` +
          `cost; compare it against "at list" above rather than assuming a discount.`
      );
    } else {
      // Not live, clock fine, priced. When a promo is not live costFor assigns
      // billedUsd = listUsd outright, so billedAtList is necessarily true here
      // — there is no further money state left to describe.
      //
      // Renders the REASON, like branch 1 does. "Not in effect" is true of both
      // a lapsed window and one that has not opened, so this was not a false
      // sentence — but saying `(through <date>)` about a promo that starts next
      // year invites the reader to mistake a start date for an end date, which
      // is the confusion that produced hole 5 one branch over.
      lines.push(
        promo.windowState === "notYetOpen"
          ? `${LOG_PREFIX} ${promo.model} has an introductory rate that has not opened yet ` +
              `(window ends ${promo.endsOn}); billed is list price.`
          : `${LOG_PREFIX} ${promo.model} introductory pricing (through ${promo.endsOn}) is not ` +
              `in effect for this run; billed is list price.`
      );
    }
  }

  // Load-bearing, and deliberately not conditional on a promotion existing.
  // Printing PRICING_VERIFIED_ON inside the promo loop above would make it
  // vanish the moment no model carries a promo — `summary.promos` would be
  // permanently empty and the date would stop appearing entirely, with nothing
  // to notice it had gone. A stale *list* price is undetectable from
  // inside this app by construction, so this line is the only staleness signal
  // there is. Removing the promo and this line together would have silently
  // disabled the tripwire while looking like a refresh.
  //
  // Reached only when the run recorded calls: the two zero-call paths above
  // return early, and rightly so — they report no cost, so no figure of theirs
  // can be stale. "Verified" here means checked against Anthropic's PUBLISHED
  // pricing, not reconciled against a Console invoice. This project has
  // conflated those before; they are different acts and only one is automated.
  lines.push(
    summary.promos.length > 0
      ? `${LOG_PREFIX} Rates last verified against published pricing ${PRICING_VERIFIED_ON}.`
      : summary.unpricedModels.length > 0
        ? // Same guard `billedAtList` already applies per model, applied here
          // too: both sites need it. With
          // an unpriced model there is no promo notice at all, so this line is
          // the only one left, and it would otherwise tell the reader that the
          // $0.000000 standing in for an UNKNOWN cost is the list price.
          `${LOG_PREFIX} Rates last verified against published pricing ${PRICING_VERIFIED_ON}. ` +
          `No promotional pricing is live for any model in this run, but see the pricing ` +
          `warning above before reading any total as a list-price figure.`
        : `${LOG_PREFIX} Rates last verified against published pricing ${PRICING_VERIFIED_ON}. ` +
          `No promotional pricing is live for any model in this run; billed is list price.`
  );

  return lines;
}
