import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLatestGeneratedAtForUser } from "@/lib/digests";

// digests.latestGeneratedAt.test.ts already pins the WIRING of this query
// (which columns/operators it calls, with what arguments) against a fake
// chain that just records calls and hands back one canned response. That
// doesn't prove the query's actual SELECTION behavior is right when there's
// more than one row in play -- and the round's own brief calls that out
// explicitly: "construct that scenario and confirm the query now falls
// through to the real older cursor."
//
// This file builds a fake Supabase client that genuinely APPLIES eq/not/lte
// as row filters and order/limit as real ordering over a small in-memory
// table, so these tests exercise the actual selection semantics -- which row
// wins -- not just which arguments the code passed to the SDK.

interface DigestRow {
  user_id: string;
  last_generated_at: string | null;
}

function makeRealisticSupabase(rows: DigestRow[]) {
  function builder(current: DigestRow[]) {
    return {
      eq(col: keyof DigestRow, val: unknown) {
        return builder(current.filter((r) => r[col] === val));
      },
      not(col: keyof DigestRow, op: string, val: unknown) {
        if (op !== "is" || val !== null) {
          throw new Error(`fake supabase: unsupported not() usage: ${op} ${val}`);
        }
        return builder(current.filter((r) => r[col] !== null));
      },
      lte(col: keyof DigestRow, val: string) {
        return builder(
          current.filter((r) => r[col] !== null && (r[col] as string) <= val)
        );
      },
      order(col: keyof DigestRow, opts: { ascending: boolean }) {
        const sorted = [...current].sort((a, b) => {
          const av = a[col] as string;
          const bv = b[col] as string;
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return opts.ascending ? cmp : -cmp;
        });
        return builder(sorted);
      },
      limit(n: number) {
        return builder(current.slice(0, n));
      },
      async maybeSingle() {
        return { data: current[0] ?? null, error: null };
      },
    };
  }

  const from = vi.fn((table: string) => {
    if (table !== "digests") throw new Error(`fake supabase: unexpected table ${table}`);
    return {
      select: vi.fn((_cols: string) => builder(rows)),
    };
  });

  return { from } as unknown;
}

const NOW = "2026-08-13T12:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getLatestGeneratedAtForUser — real row-selection behavior", () => {
  it("falls through a corrupted far-future row to the legitimate next-most-recent cursor", async () => {
    // Exactly the scenario the round's brief asks to construct: without the
    // future-timestamp filter, this MAX query would return the corrupt row
    // forever, since it's newest under a plain DESC order.
    const rows: DigestRow[] = [
      { user_id: "user-1", last_generated_at: "2026-08-16T12:00:00.000Z" }, // 3 days ahead: corrupt
      { user_id: "user-1", last_generated_at: "2026-08-12T22:00:00.000Z" }, // legitimate, 14h ago
      { user_id: "user-1", last_generated_at: "2026-08-10T09:00:00.000Z" }, // older still
    ];
    const client = makeRealisticSupabase(rows);

    const cursor = await getLatestGeneratedAtForUser(client as never, "user-1");

    expect(cursor).toBe("2026-08-12T22:00:00.000Z");
  });

  it("still selects a cursor a few seconds ahead of now over an older legitimate row (ordinary skew must win the ordering)", async () => {
    const rows: DigestRow[] = [
      { user_id: "user-1", last_generated_at: "2026-08-13T12:00:03.000Z" }, // 3s ahead: skew
      { user_id: "user-1", last_generated_at: "2026-08-12T22:00:00.000Z" }, // older
    ];
    const client = makeRealisticSupabase(rows);

    const cursor = await getLatestGeneratedAtForUser(client as never, "user-1");

    expect(cursor).toBe("2026-08-13T12:00:03.000Z");
  });

  it("scopes strictly to the requesting user — another user's row (even a valid, newer one) never wins", async () => {
    const rows: DigestRow[] = [
      { user_id: "user-2", last_generated_at: "2026-08-13T11:59:00.000Z" },
      { user_id: "user-1", last_generated_at: "2026-08-10T09:00:00.000Z" },
    ];
    const client = makeRealisticSupabase(rows);

    const cursor = await getLatestGeneratedAtForUser(client as never, "user-1");

    expect(cursor).toBe("2026-08-10T09:00:00.000Z");
  });

  it("returns null (not the corrupt value) when every one of the user's rows is either null or implausibly future", async () => {
    const rows: DigestRow[] = [
      { user_id: "user-1", last_generated_at: null },
      { user_id: "user-1", last_generated_at: "2026-08-20T00:00:00.000Z" }, // corrupt
    ];
    const client = makeRealisticSupabase(rows);

    const cursor = await getLatestGeneratedAtForUser(client as never, "user-1");

    expect(cursor).toBeNull();
  });

  it("excludes a null row even when it would otherwise sort first, returning the real newest non-null value", async () => {
    const rows: DigestRow[] = [
      { user_id: "user-1", last_generated_at: null }, // today's row, generation not finished yet
      { user_id: "user-1", last_generated_at: "2026-08-12T22:00:00.000Z" },
    ];
    const client = makeRealisticSupabase(rows);

    const cursor = await getLatestGeneratedAtForUser(client as never, "user-1");

    expect(cursor).toBe("2026-08-12T22:00:00.000Z");
  });
});
