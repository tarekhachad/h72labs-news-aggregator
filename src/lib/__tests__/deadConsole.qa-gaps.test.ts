import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Dead-console paths on the reserve and stream side, held by behaviour rather
// than only by deadConsole.test.ts's source scan.

const mocks = vi.hoisted(() => ({ settleRpc: vi.fn(), createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

import { reserveSpend } from "@/lib/spend";
import { toNdjsonStream } from "@/lib/ndjsonStream";

const TOKEN = "a".repeat(64);
const RES_ID = "11111111-2222-4333-8444-555555555555";

function killConsole() {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {
      throw new Error("console is dead");
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable");
  mocks.createClient.mockReturnValue({ rpc: mocks.settleRpc });
  mocks.settleRpc.mockResolvedValue({ data: true, error: null });
  killConsole();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const client = (rpc: ReturnType<typeof vi.fn>) => ({ rpc }) as unknown as SupabaseClient;

describe("reserveSpend with a dead console", () => {
  // In the digest route reserveSpend runs AFTER the generation claim is taken
  // and outside any try, so a throw here strands the claim.
  it.each([
    ["an RPC error", () => vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })],
    ["an unexpected shape", () => vi.fn().mockResolvedValue({ data: { weird: 1 }, error: null })],
    ["a thrown RPC", () => vi.fn().mockRejectedValue(new Error("network"))],
  ])("resolves to error on %s", async (label, makeRpc) => {
    await expect(reserveSpend(client(makeRpc()), "digest")).resolves.toEqual({ status: "error" });
    // The outer catch returns the same value, so the result alone can't tell a
    // swallowed log from one that threw into it. Only the second logs "threw".
    if (label !== "a thrown RPC") {
      const threw = vi.mocked(console.error).mock.calls.some(([m]) => String(m).includes("reserve_spend threw"));
      expect(threw).toBe(false);
    }
  });

  it("resolves to error on a timeout whose keepAlive throws", async () => {
    vi.useFakeTimers();
    const rpc = vi.fn().mockReturnValue(new Promise(() => {}));
    const pending = reserveSpend(client(rpc), "digest", {
      keepAlive: () => {
        throw new Error("after() unavailable");
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ status: "error" });
  });

  it("still settles a late grant at $0 when the console is dead", async () => {
    vi.useFakeTimers();
    let resolve!: (v: unknown) => void;
    const rpc = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    const keepAlive = vi.fn();
    const pending = reserveSpend(client(rpc), "digest", { keepAlive });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ status: "error" });
    resolve({ data: { ok: true, reservation_id: RES_ID, settle_token: TOKEN, reserved_usd: 0.7 }, error: null });
    await keepAlive.mock.calls[0][0];
    expect(mocks.settleRpc).toHaveBeenCalledWith("settle_spend", { p_id: RES_ID, p_token: TOKEN, p_actual_usd: 0 });
  });
});

describe("toNdjsonStream cancel-before-start with a dead console", () => {
  it("cancel() resolves even when the abandoned-run cleanup rejects", async () => {
    const events = (async function* () {
      yield { stage: "ingesting" };
    })();
    const cleanup = vi.fn(async () => {
      throw new Error("cleanup broke");
    });
    const stream = toNdjsonStream(events, cleanup);
    // Synchronously, before the constructor's first pull has run.
    await expect(stream.cancel()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("toNdjsonStream mid-stream disconnect with a dead console", () => {
  it("raises no unhandled rejection and runs the generator's finally once", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let inFlight!: () => void;
      const started = new Promise<void>((r) => (inFlight = r));
      let finallyRuns = 0;
      const events = (async function* () {
        try {
          yield { stage: "ingesting" };
          inFlight();
          await gate;
          yield { stage: "clustering" };
        } finally {
          finallyRuns += 1;
        }
      })();
      const reader = toNdjsonStream(events, async () => {}).getReader();
      await reader.read();
      await started;
      await reader.cancel();
      release();
      await vi.waitFor(() => expect(finallyRuns).toBe(1));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      // Proves the disconnect branch was reached. A throw from its warn is
      // absorbed by the already-cancelled stream either way, so the source
      // scan, not this test, is what keeps that line guarded.
      expect(vi.mocked(console.warn).mock.calls.some(([m]) => String(m).includes("client disconnected"))).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
