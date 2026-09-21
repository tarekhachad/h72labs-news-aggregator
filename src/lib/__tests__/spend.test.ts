import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  settleRpc: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

import {
  reserveSpend,
  settleAmount,
  settleSpend,
  spendRefusalResponse,
  type Reservation,
} from "@/lib/spend";

const TOKEN = "a".repeat(64);
const RESERVATION: Reservation = {
  id: "11111111-2222-4333-8444-555555555555",
  token: TOKEN,
  reservedUsd: 0.7,
};

function sessionClient(rpc: ReturnType<typeof vi.fn>): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

let errors: string[];

beforeEach(() => {
  vi.clearAllMocks();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable");
  mocks.createClient.mockReturnValue({ rpc: mocks.settleRpc });
  mocks.settleRpc.mockResolvedValue({ data: true, error: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reserveSpend", () => {
  it("returns the reservation on a grant and sends the kind, topic count and ref", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        reservation_id: RESERVATION.id,
        settle_token: TOKEN,
        reserved_usd: 0.7,
      },
      error: null,
    });

    const result = await reserveSpend(sessionClient(rpc), "digest", { topicCount: 13, ref: "digest-1" });

    expect(rpc).toHaveBeenCalledWith("reserve_spend", {
      p_kind: "digest",
      p_topic_count: 13,
      p_ref: "digest-1",
    });
    expect(result).toEqual({ status: "ok", reservation: RESERVATION });
  });

  it("passes the refusal reason and a normalised time through", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: false, reason: "user_budget", available_at: "2026-09-18T17:12:02.636+00:00" },
      error: null,
    });

    const result = await reserveSpend(sessionClient(rpc), "expand");

    expect(result).toEqual({
      status: "refused",
      reason: "user_budget",
      availableAt: "2026-09-18T17:12:02.636Z",
    });
  });

  it("keeps a null time as null", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: false, reason: "disabled", available_at: null },
      error: null,
    });

    expect(await reserveSpend(sessionClient(rpc), "digest")).toEqual({
      status: "refused",
      reason: "disabled",
      availableAt: null,
    });
  });

  it.each([
    ["an RPC error", { data: null, error: { message: "permission denied" } }],
    ["an unknown reason", { data: { ok: false, reason: "made_up", available_at: null }, error: null }],
    ["a grant with a non-positive amount", {
      data: { ok: true, reservation_id: RESERVATION.id, settle_token: TOKEN, reserved_usd: 0 },
      error: null,
    }],
    ["no data", { data: null, error: null }],
  ])("treats %s as an error, never as permission", async (_label, response) => {
    const rpc = vi.fn().mockResolvedValue(response);
    expect(await reserveSpend(sessionClient(rpc), "digest")).toEqual({ status: "error" });
  });

  it("treats a thrown RPC as an error", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await reserveSpend(sessionClient(rpc), "digest")).toEqual({ status: "error" });
  });

  it("treats a hung RPC as an error once the timeout passes", async () => {
    vi.useFakeTimers();
    const rpc = vi.fn().mockReturnValue(new Promise(() => {}));
    const pending = reserveSpend(sessionClient(rpc), "digest");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ status: "error" });
  });

  describe("a grant that arrives after the timeout", () => {
    function lateRpc() {
      let resolve!: (value: unknown) => void;
      const rpc = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
      return { rpc, resolve };
    }

    it("is settled at $0, and the cleanup is handed to keepAlive", async () => {
      vi.useFakeTimers();
      const { rpc, resolve } = lateRpc();
      const keepAlive = vi.fn();

      const pending = reserveSpend(sessionClient(rpc), "digest", { keepAlive });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({ status: "error" });
      expect(keepAlive).toHaveBeenCalledTimes(1);

      resolve({
        data: { ok: true, reservation_id: RESERVATION.id, settle_token: TOKEN, reserved_usd: 0.7 },
        error: null,
      });
      await keepAlive.mock.calls[0][0];

      expect(mocks.settleRpc).toHaveBeenCalledWith("settle_spend", {
        p_id: RESERVATION.id,
        p_token: TOKEN,
        p_actual_usd: 0,
      });
      expect(errors.join("\n")).not.toContain(TOKEN);
    });

    it("settles nothing when the late answer is a refusal or an error", async () => {
      vi.useFakeTimers();
      for (const late of [
        { data: { ok: false, reason: "user_budget", available_at: null }, error: null },
        { data: null, error: { message: "boom" } },
      ]) {
        const { rpc, resolve } = lateRpc();
        const keepAlive = vi.fn();
        const pending = reserveSpend(sessionClient(rpc), "digest", { keepAlive });
        await vi.advanceTimersByTimeAsync(10_000);
        await pending;
        resolve(late);
        await keepAlive.mock.calls[0][0];
      }
      expect(mocks.settleRpc).not.toHaveBeenCalled();
    });

    it("does not reject when the late call itself rejects", async () => {
      vi.useFakeTimers();
      let reject!: (err: Error) => void;
      const rpc = vi.fn().mockReturnValue(new Promise((_, r) => (reject = r)));
      const keepAlive = vi.fn();
      const pending = reserveSpend(sessionClient(rpc), "digest", { keepAlive });
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      reject(new Error("socket closed"));
      await expect(keepAlive.mock.calls[0][0]).resolves.toBeUndefined();
    });

    it("still returns error when keepAlive throws", async () => {
      vi.useFakeTimers();
      const { rpc } = lateRpc();
      const pending = reserveSpend(sessionClient(rpc), "digest", {
        keepAlive: () => {
          throw new Error("outside a request scope");
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({ status: "error" });
    });

    it("schedules no cleanup for an error that is not a timeout", async () => {
      const rpc = vi.fn().mockRejectedValue(new Error("network down"));
      const keepAlive = vi.fn();
      await reserveSpend(sessionClient(rpc), "digest", { keepAlive });
      expect(keepAlive).not.toHaveBeenCalled();
    });
  });

  it("never logs a token from a malformed grant", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, reservation_id: "not-a-uuid", settle_token: TOKEN, reserved_usd: 0.7 },
      error: null,
    });
    await reserveSpend(sessionClient(rpc), "digest");
    expect(errors.join("\n")).not.toContain(TOKEN);
  });
});

describe("settleAmount", () => {
  it("settles to the billed total", () => {
    expect(settleAmount(0.7, { totalBilledUsd: 0.21, isFloor: false })).toBe(0.21);
  });

  it("settles above the reservation when the run cost more", () => {
    expect(settleAmount(0.7, { totalBilledUsd: 0.9, isFloor: false })).toBe(0.9);
  });

  it("keeps at least the reservation for a floor record", () => {
    expect(settleAmount(0.7, { totalBilledUsd: 0.1, isFloor: true })).toBe(0.7);
    expect(settleAmount(0.7, { totalBilledUsd: 0.9, isFloor: true })).toBe(0.9);
  });

  it.each([
    ["no record", null],
    ["a NaN total", { totalBilledUsd: Number.NaN, isFloor: false }],
    ["an infinite total", { totalBilledUsd: Number.POSITIVE_INFINITY, isFloor: false }],
    ["a negative total", { totalBilledUsd: -1, isFloor: false }],
  ])("keeps the full reservation for %s", (_label, record) => {
    expect(settleAmount(0.7, record)).toBeNull();
  });
});

describe("settleSpend", () => {
  it("settles through a client with no user session", async () => {
    expect(await settleSpend(RESERVATION, 0.21)).toBe(true);

    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "publishable",
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    );
    expect(mocks.settleRpc).toHaveBeenCalledWith("settle_spend", {
      p_id: RESERVATION.id,
      p_token: TOKEN,
      p_actual_usd: 0.21,
    });
  });

  it("makes no call at all when the amount is null", async () => {
    expect(await settleSpend(RESERVATION, null)).toBe(false);
    expect(mocks.settleRpc).not.toHaveBeenCalled();
  });

  it.each([
    ["an RPC error", () => mocks.settleRpc.mockResolvedValue({ data: null, error: { message: "boom" } })],
    ["a false result", () => mocks.settleRpc.mockResolvedValue({ data: false, error: null })],
    ["a throw", () => mocks.settleRpc.mockRejectedValue(new Error("network down"))],
    ["a throwing client constructor", () => mocks.createClient.mockImplementation(() => { throw new Error("bad url"); })],
  ])("returns false and does not throw on %s", async (_label, arrange) => {
    arrange();
    await expect(settleSpend(RESERVATION, 0.21)).resolves.toBe(false);
  });

  it("returns false when the environment is missing", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    expect(await settleSpend(RESERVATION, 0.21)).toBe(false);
    expect(mocks.settleRpc).not.toHaveBeenCalled();
  });

  it("gives up after its timeout instead of hanging", async () => {
    vi.useFakeTimers();
    mocks.settleRpc.mockReturnValue(new Promise(() => {}));
    const pending = settleSpend(RESERVATION, 0.21);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(false);
  });

  it("never writes the token into a log line", async () => {
    mocks.settleRpc.mockRejectedValue(new Error("network down"));
    await settleSpend(RESERVATION, 0.21);
    await settleSpend(RESERVATION, null);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).not.toContain(TOKEN);
  });
});

describe("spendRefusalResponse", () => {
  it.each([
    ["user_count", 429],
    ["user_budget", 429],
    ["global_budget", 429],
    ["too_large", 429],
    ["disabled", 503],
  ] as const)("answers %s with %i", async (reason, status) => {
    const res = spendRefusalResponse("digest", { status: "refused", reason, availableAt: null });
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.reason).toBe(reason);
    expect(typeof body.message).toBe("string");
  });

  it("answers a failed check with 503 and no time", async () => {
    const res = spendRefusalResponse("expand", { status: "error" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      reason: "error",
      message: "Couldn't check your usage limit. Try again in a moment.",
      availableAt: null,
    });
  });

  it("carries the time for a limit", async () => {
    const res = spendRefusalResponse("digest", {
      status: "refused",
      reason: "user_count",
      availableAt: "2026-09-18T17:12:02.636Z",
    });
    expect((await res.json()).availableAt).toBe("2026-09-18T17:12:02.636Z");
  });
});
