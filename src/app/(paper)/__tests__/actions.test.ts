import { beforeEach, describe, expect, it, vi } from "vitest";

// syncTimeZone is the one write path into user_settings.time_zone from the
// client, called by TimeZoneSync on a mismatch. It never redirects (it isn't
// a form action) and never trusts its own zod check to be the real
// validation -- set_time_zone's own check against Postgres's tzdata is.
// What matters here is that a rejection at any one of the three gates (bad
// shape, no session, RPC refusal) surfaces as { ok: false } rather than a
// thrown error TimeZoneSync's .catch would treat as a console-logged
// failure instead of a normal "did not sync" result, and that a real zone
// name reaches the RPC unchanged.

const getUserMock = vi.fn();
const rpcMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    rpc: rpcMock,
  })),
}));

const { syncTimeZone } = await import("@/app/(paper)/actions");

const USER = { id: "user-1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getUserMock.mockResolvedValue({ data: { user: USER } });
  rpcMock.mockResolvedValue({ data: null, error: null });
});

describe("syncTimeZone", () => {
  it("stores a valid IANA-shaped name and reports success", async () => {
    await expect(syncTimeZone("America/New_York")).resolves.toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith("set_time_zone", { p_time_zone: "America/New_York" });
  });

  it("rejects without calling the RPC when the input isn't a string", async () => {
    await expect(syncTimeZone(42)).resolves.toEqual({ ok: false });
    await expect(syncTimeZone(null)).resolves.toEqual({ ok: false });
    await expect(syncTimeZone(undefined)).resolves.toEqual({ ok: false });
    await expect(syncTimeZone({ zone: "UTC" })).resolves.toEqual({ ok: false });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects an empty string without calling the RPC", async () => {
    await expect(syncTimeZone("")).resolves.toEqual({ ok: false });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a string over 64 characters without calling the RPC", async () => {
    // The shape check exists so an oversized value never even reaches a
    // round trip -- set_time_zone's own tzdata check would refuse it anyway,
    // but only after a network call.
    await expect(syncTimeZone("A".repeat(65))).resolves.toEqual({ ok: false });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("accepts a string at exactly the 64-character boundary", async () => {
    await expect(syncTimeZone("A".repeat(64))).resolves.toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith("set_time_zone", { p_time_zone: "A".repeat(64) });
  });

  it("refuses without calling the RPC when there is no signed-in user", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    await expect(syncTimeZone("America/New_York")).resolves.toEqual({ ok: false });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("reports failure, not a thrown error, when the RPC refuses the zone", async () => {
    // This is the case pg_timezone_names rejects a name Intl's ICU build
    // accepted (or a client sending something the zod shape check let
    // through, like "Not/AZone") -- the security-definer function is the
    // real gate, and its rejection must reach TimeZoneSync as a normal
    // { ok: false }, not a rejected promise.
    rpcMock.mockResolvedValue({ data: null, error: { message: "unknown time zone" } });

    await expect(syncTimeZone("Not/AZone")).resolves.toEqual({ ok: false });
  });

  it("does not swallow the user lookup itself failing", async () => {
    getUserMock.mockRejectedValue(new Error("network down"));

    await expect(syncTimeZone("America/New_York")).rejects.toThrow("network down");
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
