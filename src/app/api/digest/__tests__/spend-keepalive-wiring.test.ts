import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Same proof as expand-keepalive-wiring.test.ts, for the digest route: the
// real reserveSpend (unmocked) is handed `keepAlive: (task) => after(task)`,
// and a reserve_spend timeout actually reaches Next's after().

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  upsertDigestForToday: vi.fn(),
  getLatestGeneratedAtForUser: vi.fn(),
  claimGenerationForUser: vi.fn(),
  releaseGenerationClaim: vi.fn(),
  rpc: vi.fn(),
  after: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
  })),
}));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
}));

vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser,
  releaseGenerationClaim: mocks.releaseGenerationClaim,
}));

// The claim's ownership token, threaded from claimGenerationForUser to
// releaseGenerationClaim. A release presenting any other token would release
// nothing, so asserting on this value is asserting the route threads it.
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

// A controllable stand-in for the never-settling reserve_spend call — see
// expand-keepalive-wiring.test.ts for why this can't just be a Promise that
// never resolves at all (the cleanup task awaits this same call).
function deferredRpc() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI"], preferredSources: ["BBC"] });
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: CLAIM_ID });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function runPost() {
  const { POST } = await import("@/app/api/digest/route");
  return POST();
}

describe("digest route: keepAlive wiring to next/server's after()", () => {
  it("does not call after() on the normal, non-timeout path", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: false, reason: "user_count", available_at: null },
      error: null,
    });

    const res = await runPost();

    expect(res.status).toBe(429);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.releaseGenerationClaim).toHaveBeenCalledWith(expect.anything(), { claimId: CLAIM_ID });
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

    resolve({ data: { ok: false, reason: "user_budget", available_at: null }, error: null });
    await expect(task).resolves.toBeUndefined();
  });
});
