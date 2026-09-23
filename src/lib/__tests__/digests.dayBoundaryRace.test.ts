import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { upsertDigestForToday, getLatestGeneratedAtForUser } from "@/lib/digests";
import { claimGenerationForUser, releaseGenerationClaim } from "@/lib/generationClaim";

// What happens to the generation mutex across a day boundary mid-run. The
// pipeline is a long-running async generator and digestId is fixed once at
// request start (via upsertDigestForToday, keyed off todayDateString()
// evaluated at that one moment), so a run that begins at 23:59 is still
// in flight when the clock rolls over and a second request computes a NEW
// today.
//
// The claim is keyed on the USER, so that second request is refused no matter
// which day's row it would have written into. These tests drive the real
// upsertDigestForToday / claimGenerationForUser / releaseGenerationClaim
// against realistic fakes rather than canned return values.
//
// What they do NOT prove: that two genuinely overlapping database
// transactions produce exactly one winner. That is one SQL statement's
// behaviour, the fake below is single-threaded, and every interleaving here
// is one this file chose. The live probe against the real project is what
// establishes it.

interface Row {
  id: string;
  user_id: string;
  date: string;
  last_generated_at: string | null;
}

/**
 * Covers what upsertDigestForToday and getLatestGeneratedAtForUser actually
 * ask of `digests`: the read shapes the cursor query issues, and the
 * ensure_digest_for_today RPC that is now the only way a row gets created.
 * Both run against a shared, mutable row array rather than canned per-call
 * responses, so a row created by one call is visible to the next.
 *
 * The RPC fake reproduces the contract upsertDigestForToday depends on and
 * nothing more: one id per (user, date), the same id on a second call for the
 * same day. It deliberately does NOT model the function's p_date bound or its
 * auth.uid() check — those live in SQL, and a fake asserting them would only
 * be checking itself. The schema-shape test covers that they are written; the
 * live probe covers that they hold.
 *
 * It models no generation state at all, which is the point: the mutex no
 * longer lives on this table.
 */
function makeFakeDigestsTable(rows: Row[], userId = "user-1") {
  class Query implements PromiseLike<{ data: unknown; error: null }> {
    private filters: ((r: Row) => boolean)[] = [];
    private ordered: Row[] | undefined;

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

    private matched(): Row[] {
      return rows.filter((r) => this.filters.every((f) => f(r)));
    }

    async maybeSingle() {
      return { data: (this.ordered ?? this.matched())[0] ?? null, error: null };
    }

    then<TResult1, TResult2 = never>(
      onfulfilled?:
        | ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ data: this.matched(), error: null }).then(onfulfilled, onrejected);
    }
  }

  let minted = 0;

  return {
    from: vi.fn((table: string) => {
      if (table !== "digests") throw new Error(`fake digests: unexpected table ${table}`);
      return {
        select: vi.fn((_cols: string) => new Query()),
      };
    }),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "ensure_digest_for_today") {
        throw new Error(`fake digests: unexpected function ${fn}`);
      }
      const date = args.p_date as string;
      const existing = rows.find((r) => r.user_id === userId && r.date === date);
      if (existing) return { data: existing.id, error: null };

      minted += 1;
      const id = `digest-${minted}`;
      rows.push({ id, user_id: userId, date, last_generated_at: null });
      return { data: id, error: null };
    }),
  };
}

// Mirrors claim_generation / release_generation's contract: one claim row per
// user, a staleness window clamped between a floor and a ceiling, a reclaim
// that mints a fresh token, and a release that only matches the token
// currently holding the claim. The clamp bounds are the ones declared in
// supabase/schema.sql; spend-cap-wiring.test.ts is what checks the floor there
// against the route's timeout.
const SQL_FLOOR_MS = 180_000;
const SQL_CEILING_MS = 3_600_000;

function makeFakeClaimRpc() {
  let held: { claimId: string; claimedAt: number } | null = null;
  let minted = 0;

  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "claim_generation") {
        const asked = typeof args.p_stale_ms === "number" ? args.p_stale_ms : 0;
        const windowMs = Math.min(Math.max(asked, SQL_FLOOR_MS), SQL_CEILING_MS);
        if (held !== null && held.claimedAt > Date.now() - windowMs) {
          return { data: null, error: null };
        }
        minted += 1;
        held = {
          claimId: `00000000-0000-4000-8000-00000000000${minted}`,
          claimedAt: Date.now(),
        };
        return { data: held.claimId, error: null };
      }
      if (fn === "release_generation") {
        if (held !== null && held.claimId === args.p_claim_id) {
          held = null;
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      throw new Error(`fake rpc: unexpected function ${fn}`);
    }),
  };

  return {
    client,
    /** Lets a test age a claim the way the probe does with an UPDATE. */
    ageClaimBy: (ms: number) => {
      if (held !== null) held.claimedAt -= ms;
    },
    heldToken: () => held?.claimId ?? null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("day boundary: the generation claim is per user, not per digest row", () => {
  it("does not hand out a new claim just because a new day's row exists", async () => {
    const rows: Row[] = [];
    const digests = makeFakeDigestsTable(rows);
    const { client: claims } = makeFakeClaimRpc();

    // Request A starts just before midnight on day D and never releases,
    // standing in for a pipeline still mid-triage when the clock rolls over.
    vi.setSystemTime(new Date("2026-08-13T23:59:30.000Z"));
    const claimA = await claimGenerationForUser(claims as never);
    expect(claimA).not.toBeNull();
    const { digestId: idA } = await upsertDigestForToday(digests as never, "UTC");

    vi.setSystemTime(new Date("2026-08-14T00:00:05.000Z"));

    // Request B still gets a brand-new row for the new day, and that is
    // correct — asserted so the fix is not mistaken for "one row forever".
    const { digestId: idB } = await upsertDigestForToday(digests as never, "UTC");
    expect(idB).not.toBe(idA);
    expect(rows.find((r) => r.date === "2026-08-14")?.id).toBe(idB);

    // What changed: the new row buys it nothing. The claim never saw a row.
    expect(await claimGenerationForUser(claims as never)).toBeNull();
  });

  it("does not let a zombie run's late release free the claim that replaced it", async () => {
    const { client: claims, ageClaimBy, heldToken } = makeFakeClaimRpc();

    const claimA = await claimGenerationForUser(claims as never);
    if (claimA === null) throw new Error("expected the first claim to be granted");

    // A's run dies without releasing; its claim ages past the window and B
    // legitimately reclaims it, getting a token of its own.
    ageClaimBy(10 * 60 * 1000);
    const claimB = await claimGenerationForUser(claims as never);
    if (claimB === null) throw new Error("expected a stale claim to be reclaimable");
    expect(claimB.claimId).not.toBe(claimA.claimId);

    // A now comes back to life and runs its finally block. It must not take
    // B's claim down with it.
    await releaseGenerationClaim(claims as never, claimA);
    expect(heldToken()).toBe(claimB.claimId);

    // And B can still release its own.
    await releaseGenerationClaim(claims as never, claimB);
    expect(heldToken()).toBeNull();
  });

  it("still reclaims a claim left behind by a hard kill, so a crash cannot wedge a user", async () => {
    const { client: claims } = makeFakeClaimRpc();

    const abandoned = await claimGenerationForUser(claims as never);
    expect(abandoned).not.toBeNull();
    expect(await claimGenerationForUser(claims as never)).toBeNull();

    // Past the window, the next request gets in. Without this, a function
    // timeout that skips the finally block would lock the user out for good
    // rather than for three minutes.
    vi.setSystemTime(new Date(Date.now() + SQL_FLOOR_MS + 1_000));
    expect(await claimGenerationForUser(claims as never)).not.toBeNull();
  });

  it("refuses to shorten the window below the database's floor", async () => {
    const { client: claims } = makeFakeClaimRpc();

    expect(await claimGenerationForUser(claims as never)).not.toBeNull();

    // Asking for a window of zero is the attack the floor exists for: it
    // would make every live claim reclaimable on demand, which is two
    // pipelines and two worst-case spend reservations for one user.
    expect(await claimGenerationForUser(claims as never, { staleMs: 0 })).toBeNull();
    expect(await claimGenerationForUser(claims as never, { staleMs: 1 })).toBeNull();
  });

  it("leaves a run's ingest cursor alone: it reflects completed runs only", async () => {
    const rows: Row[] = [];
    const digests = makeFakeDigestsTable(rows);

    vi.setSystemTime(new Date("2026-08-13T23:59:30.000Z"));
    await upsertDigestForToday(digests as never, "UTC");

    // last_generated_at is written once, at the very end of a successful run,
    // so an in-flight run contributes nothing to the cursor. That is why the
    // mutex has to do this job: the cursor cannot detect a concurrent run.
    expect(await getLatestGeneratedAtForUser(digests as never, "user-1")).toBeNull();
  });
});
