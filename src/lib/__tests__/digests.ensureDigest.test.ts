import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { upsertDigestForToday } from "@/lib/digests";

// upsertDigestForToday's whole job is now one RPC, so what is worth pinning is
// the contract across that boundary: the argument it sends, and what it does
// with each shape of answer.
//
// The no-user-id part is the substantive one. The function used to filter on a
// user id the caller passed in; ensure_digest_for_today reads auth.uid()
// itself. Sending an id as well would be a value the database has to distrust
// anyway, and a caller that got it wrong would be asking for someone else's
// row. The test asserts the argument object exactly, so re-adding one fails.

const VALID_ID = "11111111-2222-4333-8444-555555555555";

function clientReturning(result: { data: unknown; error: unknown }) {
  return { rpc: vi.fn(async () => result) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T23:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("upsertDigestForToday", () => {
  it("asks for today's date in the reader's zone and nothing else", async () => {
    const client = clientReturning({ data: VALID_ID, error: null });

    await upsertDigestForToday(client as never, "UTC");

    expect(client.rpc).toHaveBeenCalledWith("ensure_digest_for_today", { p_date: "2026-09-21" });
  });

  it("writes into the reader's local day when it is not the UTC one", async () => {
    // 23:30 UTC on the 21st is 00:30 on the 22nd in Casablanca and 19:30 on
    // the 21st in New York. This choice is which row the whole run's cards,
    // run shape and per-topic cap belong to.
    const casablanca = clientReturning({ data: VALID_ID, error: null });
    await upsertDigestForToday(casablanca as never, "Africa/Casablanca");
    expect(casablanca.rpc).toHaveBeenCalledWith("ensure_digest_for_today", { p_date: "2026-09-22" });

    const newYork = clientReturning({ data: VALID_ID, error: null });
    await upsertDigestForToday(newYork as never, "America/New_York");
    expect(newYork.rpc).toHaveBeenCalledWith("ensure_digest_for_today", { p_date: "2026-09-21" });
  });

  it("returns the id the function minted", async () => {
    const client = clientReturning({ data: VALID_ID, error: null });

    expect(await upsertDigestForToday(client as never, "UTC")).toEqual({ digestId: VALID_ID });
  });

  it("throws when the RPC fails", async () => {
    const client = clientReturning({ data: null, error: { message: "permission denied" } });

    await expect(upsertDigestForToday(client as never, "UTC")).rejects.toThrow(/permission denied/);
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["a number", 7],
  ])("throws rather than returning a digest id of %s", async (_label, data) => {
    // The route uses this id as the digest every card in the run is written
    // under. A falsy or wrong-typed id that got past here would surface much
    // later as a confusing write failure, or -- worse -- as cards written
    // somewhere unintended. Failing at the boundary keeps the error next to
    // its cause.
    const client = clientReturning({ data, error: null });

    await expect(upsertDigestForToday(client as never, "UTC")).rejects.toThrow(/no digest id/);
  });
});
