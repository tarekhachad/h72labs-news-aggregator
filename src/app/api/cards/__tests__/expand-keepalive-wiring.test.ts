import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Proves the actual wiring the plan promises: the expand route passes
// `keepAlive: (task) => after(task)` to the REAL reserveSpend (not a mock of
// @/lib/spend), and when reserve_spend times out, that real code path calls
// Next's `after()`. `@/lib/spend` is intentionally left unmocked here —
// every other test file mocks it away, which would hide a wiring mistake
// (e.g. forgetting the keepAlive option, or passing the wrong function).
//
// The $0-late-settle mechanics themselves (settleLateGrant) are already
// unit-tested end to end in src/lib/__tests__/spend.test.ts — what this file
// adds is proof that the route really hands the real after() the real
// cleanup task, and that task resolves rather than throwing once the late
// call answers.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  after: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }),
    }),
    rpc: mocks.rpc,
  })),
}));

const CARD_ID = "11111111-2222-4333-8444-555555555555";

// A controllable stand-in for the never-settling reserve_spend call: it
// stays pending until resolveLate() is called, unlike a Promise that never
// resolves at all, which would also make the *cleanup* task (which awaits
// this same call) hang forever — that's real behaviour, not a test bug, so
// the test must be able to let it resolve.
function deferredRpc() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.maybeSingle.mockResolvedValue({
    data: {
      id: CARD_ID,
      topic: "Tech/AI",
      short_summary: "a short summary",
      expanded_report: null,
      sources: [],
    },
    error: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function runPost() {
  const { POST } = await import("@/app/api/cards/[id]/expand/route");
  return POST(new Request("http://localhost/api/cards/x/expand", { method: "POST" }), {
    params: Promise.resolve({ id: CARD_ID }),
  });
}

describe("expand route: keepAlive wiring to next/server's after()", () => {
  it("does not call after() on the normal, non-timeout path", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: false, reason: "user_count", available_at: null },
      error: null,
    });

    const res = await runPost();

    expect(res.status).toBe(429);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("calls after() with the cleanup task when reserve_spend times out, and the task resolves once the late call settles", async () => {
    vi.useFakeTimers();
    const { promise, resolve } = deferredRpc();
    mocks.rpc.mockReturnValue(promise);

    const pending = runPost();
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;

    expect(res.status).toBe(503);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    const task = mocks.after.mock.calls[0][0];
    expect(task).toBeInstanceOf(Promise);

    // The late call finally answers (a refusal here) — the cleanup task must
    // resolve cleanly rather than rejecting, since after() runs it un-awaited
    // and an unhandled rejection there would crash the function.
    resolve({ data: { ok: false, reason: "user_budget", available_at: null }, error: null });
    await expect(task).resolves.toBeUndefined();
  });
});
