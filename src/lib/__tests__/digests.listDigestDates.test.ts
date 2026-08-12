import { describe, it, expect, vi, afterEach } from "vitest";
import { listDigestDatesForUser } from "@/lib/digests";

/**
 * Fake Supabase client mimicking the chainable shape listDigestDatesForUser
 * uses: .from().select().eq().lt().order() — and, only when a `range` is
 * passed, a further .gte().lte(). The terminal object is thenable so the
 * function's `await query` resolves it whether or not the range branch ran,
 * which is what lets one fake cover both paths.
 */
function makeFakeSupabase(response: { data: unknown; error: unknown }) {
  const lte = vi.fn();
  const gte = vi.fn();
  const order = vi.fn();
  const lt = vi.fn();
  const eq = vi.fn();
  const select = vi.fn();
  const from = vi.fn();

  // Every chain step returns the same object, which is also thenable —
  // so `await query` works at whatever point the caller stops chaining.
  const chain = {
    lt,
    eq,
    order,
    gte,
    lte,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(response).then(resolve),
  };

  lte.mockReturnValue(chain);
  gte.mockReturnValue(chain);
  order.mockReturnValue(chain);
  lt.mockReturnValue(chain);
  eq.mockReturnValue(chain);
  select.mockReturnValue(chain);
  from.mockReturnValue({ select });

  return { client: { from } as unknown, from, select, eq, lt, order, gte, lte };
}

/** Freezes the clock so "today" is deterministic regardless of when tests run. */
function freezeDate(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
});

const row = (date: string, count: number) => ({ date, cards: [{ count }] });

describe("listDigestDatesForUser", () => {
  it("excludes today by querying strictly earlier than the UTC day", async () => {
    freezeDate("2026-08-12T15:00:00Z");
    const { client, from, select, eq, lt, order } = makeFakeSupabase({
      data: [row("2026-08-11", 5)],
      error: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listDigestDatesForUser(client as any, "user-1");

    expect(from).toHaveBeenCalledWith("digests");
    expect(select).toHaveBeenCalledWith("date, cards(count)");
    expect(eq).toHaveBeenCalledWith("user_id", "user-1");
    // The whole point of 8.1: a strict `<`, not `<=`.
    expect(lt).toHaveBeenCalledWith("date", "2026-08-12");
    expect(order).toHaveBeenCalledWith("date", { ascending: false });
  });

  it("uses the UTC day, not the local one, when picking today's cutoff", async () => {
    // 03:00 UTC on the 12th is still the 11th in the Americas. The cutoff
    // must follow UTC, matching todayDateString() and every other date
    // boundary in the app — a local-day cutoff here would disagree with
    // the front page about which digest is "today".
    freezeDate("2026-08-12T03:00:00Z");
    const { client, lt } = makeFakeSupabase({ data: [], error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listDigestDatesForUser(client as any, "user-1");

    expect(lt).toHaveBeenCalledWith("date", "2026-08-12");
  });

  it("returns past dates with their card counts", async () => {
    freezeDate("2026-08-12T15:00:00Z");
    const { client } = makeFakeSupabase({
      data: [row("2026-08-11", 5), row("2026-08-10", 12)],
      error: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listDigestDatesForUser(client as any, "user-1");

    expect(result).toEqual([
      { date: "2026-08-11", cardCount: 5 },
      { date: "2026-08-10", cardCount: 12 },
    ]);
  });

  it("drops dates with zero cards", async () => {
    // A day whose generation started but persisted nothing (every cluster
    // failing triage, or an abandoned run) leaves a bare `digests` row.
    // Before 8.1 that rendered as a clickable "0 cards" entry leading to
    // an empty page — the same row-vs-content confusion Phase 7.2 fixed
    // in digestExistsForDate but didn't fix here.
    freezeDate("2026-08-12T15:00:00Z");
    const { client } = makeFakeSupabase({
      data: [row("2026-08-11", 0), row("2026-08-10", 3), row("2026-08-09", 0)],
      error: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listDigestDatesForUser(client as any, "user-1");

    expect(result).toEqual([{ date: "2026-08-10", cardCount: 3 }]);
  });

  it("handles PostgREST returning the count embed as an object rather than an array", async () => {
    freezeDate("2026-08-12T15:00:00Z");
    const { client } = makeFakeSupabase({
      data: [{ date: "2026-08-11", cards: { count: 4 } }],
      error: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listDigestDatesForUser(client as any, "user-1");

    expect(result).toEqual([{ date: "2026-08-11", cardCount: 4 }]);
  });

  it("treats a missing count embed as zero, and therefore drops the row", async () => {
    freezeDate("2026-08-12T15:00:00Z");
    const { client } = makeFakeSupabase({
      data: [{ date: "2026-08-11", cards: null }],
      error: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listDigestDatesForUser(client as any, "user-1");

    expect(result).toEqual([]);
  });

  it("still applies an explicit range on top of the today cutoff", async () => {
    // The `range` param is the reserved extension point for a future
    // month-grid view. 8.1 must not have broken it, and its bounds stack
    // with the today exclusion rather than replacing it.
    freezeDate("2026-08-12T15:00:00Z");
    const { client, lt, gte, lte } = makeFakeSupabase({ data: [], error: null });

    await listDigestDatesForUser(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      "user-1",
      { from: "2026-08-01", to: "2026-08-31" }
    );

    expect(lt).toHaveBeenCalledWith("date", "2026-08-12");
    expect(gte).toHaveBeenCalledWith("date", "2026-08-01");
    expect(lte).toHaveBeenCalledWith("date", "2026-08-31");
  });

  it("returns an empty array when the user has no past digests", async () => {
    freezeDate("2026-08-12T15:00:00Z");
    const { client } = makeFakeSupabase({ data: null, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await listDigestDatesForUser(client as any, "user-1");

    expect(result).toEqual([]);
  });

  it("throws a descriptive error when the query fails", async () => {
    freezeDate("2026-08-12T15:00:00Z");
    const { client } = makeFakeSupabase({ data: null, error: { message: "boom" } });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listDigestDatesForUser(client as any, "user-1")
    ).rejects.toThrow(/listDigestDatesForUser: boom/);
  });
});
