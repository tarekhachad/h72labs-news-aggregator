import { describe, it, expect, vi } from "vitest";
import { getLatestGeneratedAtForUser } from "@/lib/digests";

/**
 * Fake Supabase client mimicking the chain getLatestGeneratedAtForUser uses:
 * .from().select().eq().not().lte().order().limit().maybeSingle(). Every step
 * returns the same object so the assertions can inspect any link in the
 * chain, and maybeSingle() is the terminal that resolves.
 */
function makeFakeSupabase(response: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(response);
  const limit = vi.fn();
  const order = vi.fn();
  const lte = vi.fn();
  const not = vi.fn();
  const eq = vi.fn();
  const select = vi.fn();
  const from = vi.fn();

  const chain = { eq, not, lte, order, limit, maybeSingle };
  limit.mockReturnValue(chain);
  order.mockReturnValue(chain);
  lte.mockReturnValue(chain);
  not.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  select.mockReturnValue(chain);
  from.mockReturnValue({ select });

  return { client: { from } as unknown, from, select, eq, not, lte, order, limit };
}

describe("getLatestGeneratedAtForUser", () => {
  it("returns the most recent last_generated_at across all of the user's digests", async () => {
    const { client } = makeFakeSupabase({
      data: { last_generated_at: "2026-08-12T22:14:00Z" },
      error: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cursor = await getLatestGeneratedAtForUser(client as any, "user-1");

    expect(cursor).toBe("2026-08-12T22:14:00Z");
  });

  it("scopes to the user and asks for the single newest row, newest first", async () => {
    const { client, from, select, eq, order, limit } = makeFakeSupabase({
      data: null,
      error: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getLatestGeneratedAtForUser(client as any, "user-1");

    expect(from).toHaveBeenCalledWith("digests");
    expect(select).toHaveBeenCalledWith("last_generated_at");
    expect(eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(order).toHaveBeenCalledWith("last_generated_at", { ascending: false });
    expect(limit).toHaveBeenCalledWith(1);
    // Deliberately NOT filtered by date: the whole point of F.4.4 is that
    // the cursor spans days rather than resetting at midnight.
    expect(eq).toHaveBeenCalledTimes(1);
  });

  it("filters nulls out in SQL rather than relying on the ordering", async () => {
    // Load-bearing, not defensive: Postgres sorts NULLs FIRST under DESC, so
    // an ungenerated row (an interrupted run, or today's row moments after
    // it was created) would win the ordering and hand back null -- exactly
    // the every-day-resets-to-null bug this function exists to fix.
    const { client, not } = makeFakeSupabase({ data: null, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getLatestGeneratedAtForUser(client as any, "user-1");

    expect(not).toHaveBeenCalledWith("last_generated_at", "is", null);
  });

  it("excludes implausibly-future rows in SQL so a corrupt one can't win the ordering", async () => {
    // This is a MAX query: it returns one row and discards every other
    // timestamp before any caller sees them. A single corrupt far-future
    // value would therefore win on every call forever, and the legitimate
    // next-most-recent cursor would be unrecoverable downstream. Excluding
    // it here is what lets the query fall through to the real one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));
    const { client, lte } = makeFakeSupabase({ data: null, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getLatestGeneratedAtForUser(client as any, "user-1");

    // now + FUTURE_CURSOR_TOLERANCE_MS (5 min), not bare `now`: a cursor a
    // few seconds ahead is ordinary skew and still the correct cursor.
    expect(lte).toHaveBeenCalledWith("last_generated_at", "2026-08-13T12:05:00.000Z");
    vi.useRealTimers();
  });

  it("returns null when the user has never successfully generated", async () => {
    const { client } = makeFakeSupabase({ data: null, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await getLatestGeneratedAtForUser(client as any, "user-1")).toBeNull();
  });

  it("returns null when the row exists but its timestamp is null", async () => {
    // Shouldn't happen given the .not() filter, but a null here must not
    // become `undefined` and slip past the caller's `string | null` contract.
    const { client } = makeFakeSupabase({
      data: { last_generated_at: null },
      error: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await getLatestGeneratedAtForUser(client as any, "user-1")).toBeNull();
  });

  it("throws on a query error instead of silently reporting no cursor", async () => {
    // Degrading to null here would re-ingest the full 48h window and
    // re-cover stories the user already has -- a wrong answer that looks
    // like a legitimate first run.
    const { client } = makeFakeSupabase({
      data: null,
      error: { message: "connection reset" },
    });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLatestGeneratedAtForUser(client as any, "user-1")
    ).rejects.toThrow("getLatestGeneratedAtForUser: connection reset");
  });
});
