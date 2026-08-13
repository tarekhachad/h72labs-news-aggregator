import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  upsertDigestForToday,
  claimDigestForGeneration,
  releaseDigestGeneration,
  getLatestGeneratedAtForUser,
} from "@/lib/digests";

// This round's brief asks specifically what happens "across a day boundary
// mid-run": the pipeline is a long-running async generator, digestId is
// fixed once at request start (via upsertDigestForToday, itself keyed off
// todayDateString() evaluated at that one moment), and the generation-mutex
// claim (claimDigestForGeneration) is scoped to that single digest ROW, not
// to the user. Nothing in route.ts or digests.ts holds a lock across a
// user's rows -- only within one.
//
// That means a run started just before midnight (still "generating" on
// yesterday's row when the clock ticks over) does NOT block a second
// request that lands after midnight: that second request computes a NEW
// today, upserts a brand-new row for it, and claims THAT row -- a claim
// which has nothing to do with yesterday's row still being held. This file
// drives the real upsertDigestForToday/claimDigestForGeneration/
// getLatestGeneratedAtForUser against a realistic in-memory fake (not a
// stubbed return value) to confirm this is real, reproducible behavior and
// not just a reading of the code.

interface Row {
  id: string;
  user_id: string;
  date: string;
  last_generated_at: string | null;
  generating: boolean;
  generation_started_at: string | null;
}

/**
 * A small but genuinely-applied fake covering exactly the query shapes
 * upsertDigestForToday / claimDigestForGeneration / releaseDigestGeneration /
 * getLatestGeneratedAtForUser issue against `digests`. Filters are applied
 * as real predicates over a shared, mutable row array (not canned per-call
 * responses), so an update from one call is visible to the next -- the
 * same "realistic filtering fake" style already used in
 * digests.latestGeneratedAt.corruption.test.ts, extended to cover writes.
 */
function makeFakeDigestsTable(rows: Row[]) {
  class Query implements PromiseLike<{ data: unknown; error: null }> {
    private filters: ((r: Row) => boolean)[] = [];
    constructor(
      private mode: "select" | "update",
      private patch?: Partial<Row>
    ) {}

    eq(col: keyof Row, val: unknown) {
      this.filters.push((r) => r[col] === val);
      return this;
    }

    not(col: keyof Row, op: string, val: unknown) {
      if (op !== "is" || val !== null) {
        throw new Error(`fake digests: unsupported not() usage: ${op} ${val}`);
      }
      this.filters.push((r) => r[col] !== null);
      return this;
    }

    lte(col: keyof Row, val: string) {
      this.filters.push((r) => r[col] !== null && (r[col] as string) <= val);
      return this;
    }

    order(col: keyof Row, opts: { ascending: boolean }) {
      const matched = this.matched();
      matched.sort((a, b) => {
        const av = a[col] as string;
        const bv = b[col] as string;
        if (av === bv) return 0;
        const cmp = av < bv ? -1 : 1;
        return opts.ascending ? cmp : -cmp;
      });
      this.ordered = matched;
      return this;
    }

    limit(n: number) {
      this.ordered = (this.ordered ?? this.matched()).slice(0, n);
      return this;
    }

    private ordered: Row[] | undefined;

    /** Only claimDigestForGeneration's compare-and-swap uses this. */
    or(expr: string) {
      const clauses = expr.split(",");
      const preds = clauses.map((clause) => {
        if (clause.startsWith("generating.eq.")) {
          const val = clause.slice("generating.eq.".length) === "true";
          return (r: Row) => r.generating === val;
        }
        if (clause.startsWith("generation_started_at.lt.")) {
          const val = clause.slice("generation_started_at.lt.".length);
          return (r: Row) => r.generation_started_at !== null && r.generation_started_at < val;
        }
        throw new Error(`fake digests: unsupported or() clause: ${clause}`);
      });
      this.filters.push((r) => preds.some((p) => p(r)));
      return this;
    }

    private matched(): Row[] {
      return rows.filter((r) => this.filters.every((f) => f(r)));
    }

    private applyIfUpdate(): Row[] {
      const matched = this.matched();
      if (this.mode === "update" && this.patch) {
        matched.forEach((r) => Object.assign(r, this.patch));
      }
      return matched;
    }

    /** Terminal for a select().eq()...maybeSingle() chain. */
    async maybeSingle() {
      return { data: (this.ordered ?? this.matched())[0] ?? null, error: null };
    }

    /** Terminal for update(...).eq(...).or(...).select("id") (claim). */
    select(_cols: string) {
      const matched = this.applyIfUpdate();
      return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
    }

    /** Awaited directly with no .select() -- update(...).eq(...) (release). */
    then<TResult1, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
      this.applyIfUpdate();
      return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
    }
  }

  return {
    from: vi.fn((table: string) => {
      if (table !== "digests") throw new Error(`fake digests: unexpected table ${table}`);
      return {
        select: vi.fn((_cols: string) => new Query("select")),
        insert: vi.fn((row: Partial<Row>) => {
          const exists = rows.some((r) => r.user_id === row.user_id && r.date === row.date);
          if (exists) {
            return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
          }
          rows.push({
            last_generated_at: null,
            generating: false,
            generation_started_at: null,
            ...row,
          } as Row);
          return Promise.resolve({ error: null });
        }),
        update: vi.fn((patch: Partial<Row>) => new Query("update", patch)),
      };
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("day-boundary interaction: the generation claim is per-row, not per-user", () => {
  it("a second request landing just after midnight can claim a NEW row and start generating even while yesterday's row is still mid-generation", async () => {
    const rows: Row[] = [];
    const client = makeFakeDigestsTable(rows);

    // Request A starts just before midnight, day D.
    vi.setSystemTime(new Date("2026-08-13T23:59:30.000Z"));
    const { digestId: idA } = await upsertDigestForToday(client as never, "user-1");
    const claimedA = await claimDigestForGeneration(client as never, idA);
    expect(claimedA).toBe(true);
    // Row A is now "generating" and never got released -- simulating a
    // pipeline still in flight (e.g. mid-triage) when the clock rolls over.
    expect(rows.find((r) => r.id === idA)?.generating).toBe(true);

    // The clock rolls over to day D+1 while request A is still running.
    vi.setSystemTime(new Date("2026-08-14T00:00:05.000Z"));

    // Request B (a retry, a second tab, or just the user reloading) lands.
    const { digestId: idB } = await upsertDigestForToday(client as never, "user-1");
    expect(idB).not.toBe(idA);
    expect(rows.find((r) => r.date === "2026-08-14")?.id).toBe(idB);

    // The claim for B's (brand new, never-claimed) row succeeds -- nothing
    // about A's row being mid-generation is visible to this check at all,
    // because claimDigestForGeneration's WHERE only ever matches `id = idB`.
    const claimedB = await claimDigestForGeneration(client as never, idB);
    expect(claimedB).toBe(true);

    // Both rows are now simultaneously "generating" for the same user --
    // two real pipeline runs could be in flight at once, each free to call
    // ingestArticles/writeCard/saveGeneratedCards independently.
    expect(rows.find((r) => r.id === idA)?.generating).toBe(true);
    expect(rows.find((r) => r.id === idB)?.generating).toBe(true);
  });

  it("consequently, run B's cursor cannot see run A's in-flight work: both runs' ingestion windows overlap and neither dedupes against the other", async () => {
    const rows: Row[] = [];
    const client = makeFakeDigestsTable(rows);

    vi.setSystemTime(new Date("2026-08-13T23:59:30.000Z"));
    const { digestId: idA } = await upsertDigestForToday(client as never, "user-1");
    await claimDigestForGeneration(client as never, idA);
    const cursorForA = await getLatestGeneratedAtForUser(client as never, "user-1");

    vi.setSystemTime(new Date("2026-08-14T00:00:05.000Z"));
    const { digestId: idB } = await upsertDigestForToday(client as never, "user-1");
    await claimDigestForGeneration(client as never, idB);
    const cursorForB = await getLatestGeneratedAtForUser(client as never, "user-1");

    // Neither run has persisted anything yet (saveGeneratedCards/
    // persist_generated_cards only runs at the very end of a successful
    // pipeline), so both queries see the exact same pre-run state --
    // here, a brand-new user with no prior successful generation at all.
    expect(cursorForA).toBeNull();
    expect(cursorForB).toBeNull();
    // Run B has no way to know run A (still in flight) exists, let alone
    // where its ingestion window started -- getLatestGeneratedAtForUser
    // only ever reflects COMPLETED runs (last_generated_at is set once, at
    // the very end, by persist_generated_cards). ingestArticles for both
    // runs would independently fall back to the same 48h ceiling and pull
    // overlapping (likely near-identical) article sets, with no shared
    // getTodaysCardSummaries view to dedupe across the two digest_id rows.
  });

  it("releasing run A's claim after the fact does not retroactively affect run B's already-independent row", async () => {
    const rows: Row[] = [];
    const client = makeFakeDigestsTable(rows);

    vi.setSystemTime(new Date("2026-08-13T23:59:30.000Z"));
    const { digestId: idA } = await upsertDigestForToday(client as never, "user-1");
    await claimDigestForGeneration(client as never, idA);

    vi.setSystemTime(new Date("2026-08-14T00:00:05.000Z"));
    const { digestId: idB } = await upsertDigestForToday(client as never, "user-1");
    await claimDigestForGeneration(client as never, idB);

    await releaseDigestGeneration(client as never, idA);

    expect(rows.find((r) => r.id === idA)?.generating).toBe(false);
    // B's claim is untouched -- confirms the two rows' generation state is
    // fully independent in both directions, not just at claim time.
    expect(rows.find((r) => r.id === idB)?.generating).toBe(true);
  });
});
