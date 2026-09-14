/**
 * Where a run's cost record actually goes.
 *
 * The impure half of the pair with `usageRecord.ts`, kept separate for the
 * same reason `usage.ts` and `usageCollector.ts` are: the arithmetic that
 * will size V2.0's spend caps must be testable with no filesystem and no
 * network, and mixing the two would make every test of the shape a test of
 * the plumbing.
 *
 * Two sinks, on purpose, because they fail in different ways and are read by
 * different things:
 *
 * - **JSONL**, local, and **written in development only**. What
 *   `npm run cost-report` reads. It carries no `user_id` (see `toJsonlLine`).
 *   It is gitignored by a rule that names this path specifically — note that
 *   `notes-logs/cost-test-log*` covers only the old flat transcripts and does
 *   NOT match `notes-logs/cost/runs.jsonl`. This is a public repo.
 * - **Supabase**, the durable copy and the one a per-user cap can read. Note
 *   what it is NOT: an enforcement source. Every write goes through the
 *   user's own cookie session under RLS (this app has no service-role client
 *   anywhere), so a user holding their own JWT can insert a row claiming
 *   `total_billed_usd: 0` and every policy passes. A cap must SIZE itself
 *   from this table and ENFORCE against something the subject cannot write
 *   downward — a count of insert-only `digests` rows.
 *
 * **`emitUsageRun` is total: it never rejects, and it never hangs.** That is
 * a hard requirement, not defensiveness. It is called from the digest
 * route's `finally`, and a call there that never settles would block the
 * stream from closing and lock the user out of generating again until the
 * stale-claim window (2 min) expires. A `try/catch` handles a throw; only a
 * timeout handles a hang.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LOG_PREFIX } from "@/lib/usage";
import { toJsonlLine, toUsageRunRow, type UsageRunRecord } from "@/lib/usageRecord";

/**
 * The local run log. Gitignored, and read by `scripts/cost-report.ts` —
 * exported so the writer and the reader cannot drift onto two paths, which
 * would present as an empty report rather than an error.
 */
export const USAGE_RUNS_JSONL = join(process.cwd(), "notes-logs", "cost", "runs.jsonl");

export type UsageSink = (record: UsageRunRecord) => Promise<void>;

/** The injection seam. `fs.appendFile`'s shape, narrowed to what is used. */
export type AppendFile = (path: string, contents: string) => Promise<void>;

/**
 * The default writer: creates the containing directory, then appends.
 *
 * The `mkdir` is not incidental. A missing directory makes `appendFile`
 * reject with ENOENT, `emitUsageRun` swallows it, and the result is a cost
 * pipeline that silently records nothing — the precise failure mode this
 * whole phase exists to end. `recursive: true` makes it a no-op once the
 * directory is there.
 */
async function appendCreatingDir(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, contents, "utf8");
}

/**
 * Appends one JSON object per line to `path`.
 *
 * The writer is injected the same way `usage.ts` injects its clock and its
 * pricing table, and for a stronger reason here: this suite has **zero**
 * filesystem usage and no setup file, and a sink that could only be tested
 * by writing to disk would have to introduce both.
 */
export function createJsonlSink(
  path: string = USAGE_RUNS_JSONL,
  append: AppendFile = appendCreatingDir
): UsageSink {
  return async (record) => {
    // toJsonlLine supplies its own trailing newline, so a caller cannot fuse
    // two records by forgetting one.
    await append(path, toJsonlLine(record));
  };
}

/**
 * Inserts one row into `public.usage_runs`.
 *
 * Rejects on a Postgres error rather than returning quietly, so
 * `emitUsageRun` logs it. Swallowing here would leave the two sinks able to
 * disagree about a run with nothing said — and cross-checking them against
 * each other is the only verification this design has that either is right.
 */
export function createSupabaseSink(supabase: SupabaseClient): UsageSink {
  return async (record) => {
    const { error } = await supabase.from("usage_runs").insert(toUsageRunRow(record));
    if (error) {
      throw new Error(`usage_runs insert failed: ${error.message}`);
    }
  };
}

/**
 * The sinks a live route should use.
 *
 * The JSONL sink is included ONLY in development — an allowlist, not a
 * "everything except production" denylist. Both excluded environments are
 * excluded for a concrete reason:
 *
 * - **production**: Vercel's filesystem is read-only outside an ephemeral
 *   `/tmp`, so the write throws on every run, is swallowed here, and leaves a
 *   file that never appears.
 * - **test**: this suite has ZERO filesystem usage by design, and the routes
 *   are driven end-to-end by nine wiring test files. A denylist here lets every
 *   `vitest run` append a real line per simulated run to the real
 *   `notes-logs/cost/runs.jsonl`. That is unbounded local disk growth, it makes
 *   the suite depend on a writable filesystem, and worst of all it mixes
 *   fabricated test runs into the file the cost report averages.
 *
 * Written as an allowlist precisely because that bug came from a denylist:
 * "not production" silently included an environment nobody had considered.
 * A new environment now has to opt IN to disk writes.
 *
 * Read at call time rather than module load, so the decision belongs to the
 * request rather than to whenever the bundler evaluated this file.
 */
export function defaultUsageSinks(supabase: SupabaseClient): UsageSink[] {
  const sinks: UsageSink[] = [createSupabaseSink(supabase)];
  if (process.env.NODE_ENV === "development") {
    sinks.push(createJsonlSink());
  }
  return sinks;
}

/**
 * Runs every sink, and **cannot** reject or hang.
 *
 * Each sink is raced against `timeoutMs`. A sink that rejects, throws
 * synchronously, or never settles is reported to `console.error` and
 * otherwise ignored; the others still run. The timer is always cleared, so a
 * fast run never leaves a pending timeout holding the event loop open — on a
 * serverless function that is the difference between finishing and being
 * billed for two more seconds of wall clock.
 *
 * The failure it is designed against is specific: this is awaited in the
 * digest route's `finally`, AFTER `releaseDigestGeneration`. The ordering is
 * the first line of defence and the timeout is the second, because ordering
 * alone stops a hang from stranding the mutex but not from stranding the
 * response stream.
 */
export async function emitUsageRun(
  sinks: UsageSink[],
  record: UsageRunRecord,
  timeoutMs = 2000
): Promise<void> {
  await Promise.all(sinks.map((sink) => runOneSink(sink, record, timeoutMs)));
}

async function runOneSink(
  sink: UsageSink,
  record: UsageRunRecord,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The sink is invoked INSIDE this wrapper so that a sink throwing
    // synchronously — rather than returning a rejected promise — becomes a
    // rejection like any other.
    //
    // What this wrapper does NOT do: it is not what keeps this function total.
    // Delete it and emitUsageRun still resolves, because the outer catch
    // backstops a sync throw on its own. What it protects is the DIAGNOSTIC —
    // without it a sync throw falls to the outer catch and is reported as
    // "could not be run at all", which this function reserves for its own
    // plumbing failing, instead of naming the sink as the thing that broke.
    // A test asserts the message, not just the resolution.
    const work = (async () => sink(record))();
    // `settled` can only ever RESOLVE — a rejection becomes a value.
    //
    // Being precise about what this does and does not buy, because the
    // obvious rationale for it is wrong: it is NOT what prevents an
    // unhandled rejection. `Promise.race` attaches its own handlers to every
    // input, so a sink that rejects long after the timeout won the race is
    // already absorbed by the race itself. What this buys is that a
    // rejection arrives here as a VALUE rather than by unwinding, so it is
    // reported by the sink-failure branch below — which names the sink as the
    // thing that failed — instead of falling through to the outer catch,
    // whose message is about the timeout machinery. The outer catch stays
    // what it claims to be: a guard on this function's own plumbing.
    //
    // The no-unhandled-rejection property is still worth pinning by test,
    // since it would break under a hand-rolled timeout that watched only
    // `work`'s fulfilment.
    const settled = work.then(
      () => ({ failed: false } as const),
      (error: unknown) => ({ failed: true, error } as const)
    );
    const timeout = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    });

    const outcome = await Promise.race([settled, timeout]);

    if (outcome === "timed-out") {
      // The sink's own promise stays pending; nothing can be done about that.
      // What matters is that this function has stopped waiting on it.
      // Reported rather than swallowed, because a sink that hangs once will
      // hang on every run after it, and the records go missing silently.
      report(`a usage sink did not settle within ${timeoutMs}ms — this run was not recorded there`);
    } else if (outcome.failed) {
      report("a usage sink failed — this run was not recorded there", outcome.error);
    }
  } catch (error) {
    // Only reachable if the machinery above fails (setTimeout throwing, say),
    // not from the sink itself. Total means total.
    report("a usage sink could not be run at all", error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * console.error, and itself guarded — this handler exists precisely because
 * the thing it is reporting on can fail, and the same nested-guard shape
 * `usageCollector` uses for the identical reason.
 */
function report(message: string, error?: unknown): void {
  try {
    if (error === undefined) console.error(`${LOG_PREFIX} ${message}`);
    else console.error(`${LOG_PREFIX} ${message} —`, error);
  } catch {
    // Genuinely nothing left to try.
  }
}
