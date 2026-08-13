import { AsyncLocalStorage } from "node:async_hooks";
import {
  formatCallLine,
  formatUsageSummary,
  normalizeUsage,
  summarizeUsage,
  type CallTokens,
  type RecordedCall,
  type SummaryOptions,
  type TrackedModel,
  type UsageStage,
  type UsageSummary,
} from "@/lib/usage";

/**
 * Captures token usage from live Claude calls and attributes it to the
 * request that made them.
 *
 * Ambient (AsyncLocalStorage) rather than threaded through return values,
 * which was the obvious first choice given this codebase's
 * pass-the-dependency-as-an-argument convention. The reason it can't work
 * here: every billed call site has a path that never reaches its `return`.
 * `rankFrontPage` catches and returns `null`; `isSameStory` catches and
 * returns `false`; `triageCluster`'s throw is swallowed by the digest
 * route's per-cluster catch; `writeCard`'s rejection is absorbed by
 * `Promise.allSettled`; and `generateWithRetryOnAmbiguousTruncation` has
 * three throw paths, the worst firing *after two billed Sonnet calls*. A
 * return value can't carry usage off a path that doesn't return, so
 * threading would report $0.00 on precisely the most expensive failures —
 * and a cost diagnosis of a partially-failing pipeline is exactly when the
 * number matters. Attaching usage to thrown Errors instead would be the
 * design admitting it's fighting the codebase.
 *
 * Ambient also gets two things free that matter here: per-request isolation
 * (two concurrent digests never merge, which a module-level singleton would
 * do silently), and correct attribution across the unbounded `Promise.all`
 * fan-outs in the triage and dedup stages, since children inherit the scope
 * at call time.
 *
 * Node-only — both consuming routes already declare `runtime = "nodejs"`.
 * Never import this from a client component.
 */

export interface UsageCollector {
  /**
   * The instant this run is priced at. Fixed for the collector's lifetime so
   * a single run can't be priced half one way and half the other if it
   * happens to span the day a promotional rate lapses.
   */
  readonly at: Date;
  /**
   * Appends an already-built record. Named `add` rather than `record` to keep
   * it clearly distinct from the free function `recordCall`, which is the one
   * call sites use — that wraps a live API call and derives the record; this
   * just stores one.
   *
   * **Call sites should use `recordCall`, never this.** `add` bypasses the
   * unreadable-usage handling and the record-then-rethrow behaviour that the
   * floor warnings depend on; it exists for tests and for anything that has
   * already derived a record by other means.
   */
  add(call: RecordedCall): void;
  /**
   * A snapshot of everything recorded so far. Both the array and the records
   * in it are frozen, so a consumer can read a run's spend but can't rewrite
   * it — a shallow array copy alone would still hand out the live `tokens`
   * objects, and mutating one of those would silently change the run's total.
   */
  calls(): readonly Readonly<RecordedCall>[];
  summarize(): UsageSummary;
  /** Emits the per-stage summary table to the console. */
  report(opts: SummaryOptions): void;
}

const storage = new AsyncLocalStorage<UsageCollector>();

export function createUsageCollector(at: Date = new Date()): UsageCollector {
  const recorded: RecordedCall[] = [];
  // Shared by `summarize` and `report` so both aggregate the same way, over
  // a copy. `summarizeUsage` doesn't mutate its input, but the two methods
  // disagreeing about that is the kind of drift that eventually matters.
  const summarize = () => summarizeUsage([...recorded], at);

  return {
    at,
    add(call) {
      // Stored as a frozen *copy*, so the record is immutable wherever it
      // travels — including through `calls()`, whose array copy would
      // otherwise still expose the live `tokens` objects behind the totals.
      // A copy rather than freezing what the caller handed over: freezing
      // their object in place would reach back out of this collector and
      // mutate something they still own, and a shared or reused
      // `CallTokens` would become frozen for every other holder of it.
      const stored = Object.freeze({
        stage: call.stage,
        model: call.model,
        tokens: call.tokens === null ? null : Object.freeze({ ...call.tokens }),
      });
      recorded.push(stored);
      // One line per call, always on. Same precedent as triage.ts's
      // per-cluster log: cheap, and the only way to inspect the shape of
      // spend without re-running paid calls by hand. Whether these stay
      // past the diagnosis is a deliberate decision at the end of the
      // phase, not something to hide behind a config flag now.
      //
      // Guarded because this runs inside `recordCall`, in the middle of a
      // billed API call's return path. An unguarded throw here would
      // propagate as if the Claude call itself had failed — dropping a card
      // in the digest pipeline, or turning a successful expand into a 502 —
      // which is instrumentation breaking the thing it exists to measure.
      // The record is already stored above, so the run's totals survive
      // even when this line doesn't.
      try {
        console.log(formatCallLine(stored, at));
      } catch {
        // Nothing useful to do: reporting the logging failure would use the
        // same channel that just failed.
      }
    },
    calls() {
      // A copy: the array below is this collector's own state, and handing
      // out the live reference lets a consumer corrupt a run's record. The
      // records themselves are already frozen by `add`.
      return [...recorded];
    },
    summarize,
    report(opts) {
      // Guarded here rather than at each call site, for the same reason
      // `add` is: both current callers happen to wrap this in their own
      // try/catch, but that makes "instrumentation can't break what it
      // measures" a convention every future caller has to remember rather
      // than a property of the collector. In the digest route the cost of
      // forgetting is a stranded generation mutex — the user locked out of
      // generating again because a log line failed.
      try {
        for (const line of formatUsageSummary(summarize(), opts)) {
          console.log(line);
        }
      } catch {
        // Nothing useful to do: reporting this would use the same channel.
      }
    },
  };
}

/**
 * Runs `fn` with `collector` ambient — every `recordCall` reached from it,
 * however deeply nested or concurrently awaited, records into `collector`.
 *
 * Enter this around individual awaited stages, **not** around an async
 * generator. `runDigestPipeline` is a generator, and context propagation
 * across `yield`/`next()` suspension is not something to stake the
 * instrumentation on: the failure mode is a silent $0.00, which is
 * indistinguishable from a free run.
 */
export function withUsageCollector<T>(
  collector: UsageCollector,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(collector, fn);
}

/** The collector for the current async context, if any. */
export function currentUsageCollector(): UsageCollector | undefined {
  return storage.getStore();
}

/**
 * Wraps one Claude API call so its token usage is attributed to the
 * surrounding run.
 *
 * A no-op when no collector is in scope — it returns the response untouched
 * and records nothing. That's load-bearing, not just convenience: the
 * existing unit tests call these lib functions directly with mocked
 * responses that carry no `usage` field, and they must keep passing without
 * being rewritten.
 *
 * On throw it records a usage-less entry and **rethrows unchanged**. The
 * call may well have been billed anyway — `messages.parse` validates the
 * response against a zod schema *after* a 200 comes back, so a schema
 * mismatch throws on a request that was charged for. Counting it as
 * "billed, amount unknown" is what lets the summary label its totals a
 * floor instead of quietly under-reporting.
 *
 * Reading the usage off the response is itself inside a `try`, so that a
 * response whose `usage` is unreadable for any reason still gets counted.
 * Letting that read throw would drop the call from the record entirely —
 * not even as "billed, unknown" — which is strictly worse than the
 * under-reporting the floor warning exists to flag, because it would be
 * invisible to that warning too.
 *
 * **`call` must resolve to the raw SDK response, not something derived from
 * it.** Returning an already-unwrapped value (`.then((r) => r.parsed_output)`
 * is the easy mistake) type-checks fine and costs nothing at runtime — the
 * call simply records as usage-less forever, so the stage reports a
 * permanent FLOOR warning instead of a wiring error. `R extends object`
 * catches only the crudest version of that; the real guard is a per-call-site
 * test asserting the collector actually saw tokens.
 */
export async function recordCall<R extends object>(
  stage: UsageStage,
  model: TrackedModel,
  call: () => Promise<R>
): Promise<R> {
  const collector = storage.getStore();
  if (collector === undefined) return call();

  let response: R;
  try {
    response = await call();
  } catch (error) {
    collector.add({ stage, model, tokens: null });
    throw error;
  }

  let tokens: CallTokens | null = null;
  try {
    const usage =
      typeof response === "object" && response !== null
        ? (response as { usage?: unknown }).usage
        : undefined;
    tokens = normalizeUsage(usage);
  } catch {
    // Unreadable usage — counted as billed-but-unmeasured, same as a throw.
  }
  collector.add({ stage, model, tokens });
  return response;
}
