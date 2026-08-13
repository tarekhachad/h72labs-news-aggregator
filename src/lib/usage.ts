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
export const PRICING: Record<TrackedModel, ModelPricing> = {
  "claude-haiku-4-5": {
    list: {
      inputPerMTok: 1.0,
      outputPerMTok: 5.0,
      cacheReadMultiplier: CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
    },
  },
  "claude-sonnet-5": {
    list: {
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
      cacheReadMultiplier: CACHE_READ_MULTIPLIER,
      cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
    },
    // Sonnet 5 launched on introductory pricing. Modelled as a dated promo
    // *alongside* the list rate rather than as the rate itself, so a cost
    // measured today can always be reported next to what the identical run
    // costs once it lapses. Without this, a figure measured in August would
    // understate steady-state Sonnet spend by ~50% — and that figure is the
    // input to V2.0's spend caps, so the error would propagate.
    promo: {
      rate: {
        inputPerMTok: 2.0,
        outputPerMTok: 10.0,
        cacheReadMultiplier: CACHE_READ_MULTIPLIER,
        cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
      },
      // The end date is published; the exact start is not. This floor is
      // therefore deliberately conservative rather than precise — early
      // enough to cover any run this app could have made, late enough to
      // reject a nonsense date. Narrow it only against a documented start.
      fromUtcDate: "2026-01-01",
      throughUtcDate: "2026-08-31",
    },
  },
};

/**
 * When the rates above were last checked against Anthropic's published
 * pricing. A promo expiring is self-detecting (it's a date comparison); a
 * change to the *list* price is not detectable from inside this app at all,
 * so the next best thing is printing this in every summary so a stale table
 * is visible rather than silent.
 */
export const PRICING_VERIFIED_ON = "2026-08-13";

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

/** A token count is a non-negative finite number. `+ 0` normalizes -0 to 0. */
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
 * Every field is read with `Object.hasOwn` rather than plain property
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
 * `RangeError` on an Invalid Date, and the only caller that reaches it is the
 * promo check — which is skipped entirely for a model with no promo. That
 * would make a bad clock crash the cost report only on runs that happened to
 * involve Sonnet, i.e. a data-dependent landmine. Returning null instead
 * degrades every model the same way, and the callers treat it as "no promo
 * can be confirmed live", which prices at list. Erring toward list can
 * overstate but never understate.
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
 * Prices `tokens` both ways: what they cost on `at`, and what they cost at
 * list. Both figures are always returned — reporting only the billed number
 * bakes a temporary discount into a document that outlives it, and reporting
 * only list misstates what the card was actually charged.
 *
 * The promo is a date gate, not a swapped-in table, so it expires on its own:
 * past `throughUtcDate` the comparison simply stops matching, `promoApplied`
 * goes false, and `billedUsd === listUsd` with no code change.
 */
export function costFor(model: TrackedModel, tokens: CallTokens, at: Date): CostBreakdown {
  const pricing = PRICING[model];
  const listUsd = applyRate(tokens, pricing.list);

  const promo = pricing.promo;
  const today = utcDateString(at);
  const promoLive = promo !== undefined && today !== null && isWithinPromo(today, promo);
  const billedUsd = promoLive ? applyRate(tokens, promo.rate) : listUsd;

  return {
    billedUsd,
    listUsd,
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
}

export interface PromoNotice {
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
 * Grouped by the **(stage, model) pair**, not by stage alone. Every stage
 * uses exactly one model today, so the two are equivalent right now — but if
 * a stage ever mixed models, summing its tokens and pricing them once would
 * be wrong by up to 3x, and it would be wrong quietly. Grouping on the pair
 * makes that structurally impossible rather than relying on the invariant
 * holding forever.
 */
export function summarizeUsage(calls: RecordedCall[], at: Date): UsageSummary {
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
        cost: { billedUsd: 0, listUsd: 0, promoApplied: false, promoEndsOn: null },
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
    group.cost = costFor(group.model, group.tokens, at);
  }

  const today = utcDateString(at);
  const promos: PromoNotice[] = [];
  for (const model of new Set(stages.map((group) => group.model))) {
    const promo = PRICING[model].promo;
    if (promo !== undefined) {
      promos.push({
        model,
        endsOn: promo.throughUtcDate,
        applied: today !== null && isWithinPromo(today, promo),
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
    promos,
  };
}

/** The smallest cost `formatUsd` can render without rounding it away. */
const SMALLEST_SHOWN_USD = 0.000001;

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

const LOG_PREFIX = "[usage]";

/** One line per API call, emitted as the call completes. */
export function formatCallLine(call: RecordedCall, at: Date): string {
  if (call.tokens === null) {
    return `${LOG_PREFIX} ${call.stage} ${call.model} — no usage reported (billed amount unknown)`;
  }
  const t = call.tokens;
  const cost = costFor(call.model, t, at);
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
    lines.push(
      promo.applied
        ? `${LOG_PREFIX} ${promo.model} introductory pricing was in effect for this run and ends ` +
            `${promo.endsOn} — "at list" is what this same run costs from the day after. ` +
            `Rates last verified ${PRICING_VERIFIED_ON}.`
        : `${LOG_PREFIX} ${promo.model} introductory pricing (through ${promo.endsOn}) is not ` +
            `in effect for this run; billed is list price. ` +
            `Rates last verified ${PRICING_VERIFIED_ON}.`
    );
  }

  return lines;
}
