import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Cluster } from "@/types";

// F.4.4 split the since-cursor into two collaborators: upsertDigestForToday
// (which digest row to write into -- always today's, and no longer returns
// a cursor at all) and getLatestGeneratedAtForUser (how far back to read --
// the user's last successful run, whatever day that was). This test drives
// the REAL route.ts POST handler end-to-end and asserts the cursor that
// actually reaches ingestArticles is getLatestGeneratedAtForUser's return
// value, not anything derived from upsertDigestForToday or today's row --
// a regression here would silently resurrect the old "resets to null every
// midnight" bug even though getLatestGeneratedAtForUser itself is correct.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestArticles: vi.fn(),
  clusterArticles: vi.fn(),
  filterAlreadyCovered: vi.fn(),
  triageClusters: vi.fn(),
  writeCard: vi.fn(),
  rankFrontPage: vi.fn(),
  upsertDigestForToday: vi.fn(),
  getLatestGeneratedAtForUser: vi.fn(),
  saveGeneratedCards: vi.fn(),
  claimDigestForGeneration: vi.fn(),
  releaseDigestGeneration: vi.fn(),
  getTodaysCardSummaries: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
  })),
}));

vi.mock("@/lib/profile", () => ({
  getUserProfile: mocks.getUserProfile,
}));

vi.mock("@/lib/ingest", () => ({
  ingestArticles: mocks.ingestArticles,
}));

vi.mock("@/lib/cluster", () => ({
  clusterArticles: mocks.clusterArticles,
}));

vi.mock("@/lib/dedup", () => ({
  filterAlreadyCovered: mocks.filterAlreadyCovered,
}));

vi.mock("@/lib/triage", async () => {
  // triageBatchCount is pulled through real: it is what the cost summary
  // compares actual calls against, and a mocked-away version returns
  // undefined, which formatUsageSummary skips silently -- the expectation
  // would vanish rather than fail.
  const actual =
    await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  return {
    triageClusters: mocks.triageClusters,
    triageBatchCount: actual.triageBatchCount,
  };
});

vi.mock("@/lib/writeCard", () => ({
  writeCard: mocks.writeCard,
}));

vi.mock("@/lib/rank", () => ({
  rankFrontPage: mocks.rankFrontPage,
}));

vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards,
  claimDigestForGeneration: mocks.claimDigestForGeneration,
  releaseDigestGeneration: mocks.releaseDigestGeneration,
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
}));

const FAKE_CLUSTERS: Cluster[] = [
  {
    topic: "Tech/AI",
    articles: [
      {
        title: "A story",
        snippet: "snippet",
        url: "https://example.com",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Tech/AI"],
    preferredSources: ["BBC"],
  });
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue(FAKE_CLUSTERS);
  mocks.filterAlreadyCovered.mockResolvedValue(FAKE_CLUSTERS);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
    cs.map(() => ({ notable: false, severity: 1 })),
  );
  mocks.writeCard.mockResolvedValue(undefined);
  mocks.rankFrontPage.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
});

async function runPost() {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
}

describe("digest route: since-cursor wiring (F.4.4)", () => {
  it("passes getLatestGeneratedAtForUser's value through to ingestArticles as the since-cursor", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-08-01T03:00:00Z");

    await runPost();

    expect(mocks.ingestArticles).toHaveBeenCalledWith(
      ["Tech/AI"],
      ["BBC"],
      "2026-08-01T03:00:00Z",
    );
  });

  it("calls getLatestGeneratedAtForUser with the authenticated user's id, not the digest id", async () => {
    await runPost();

    expect(mocks.getLatestGeneratedAtForUser).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
    );
  });

  it("passes null through to ingestArticles for a user who has never generated", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);

    await runPost();

    expect(mocks.ingestArticles).toHaveBeenCalledWith(
      ["Tech/AI"],
      ["BBC"],
      null,
    );
  });

  it("uses the cross-day cursor even on a brand-new day's first run, not today's (empty) row", async () => {
    // Today's row was just created by upsertDigestForToday (no cursor of its
    // own -- the function doesn't even return one anymore), but the user
    // generated yesterday. ingestArticles must see yesterday's timestamp,
    // not null / not today's row.
    mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-today" });
    mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-08-12T23:50:00Z");

    await runPost();

    expect(mocks.ingestArticles).toHaveBeenCalledWith(
      ["Tech/AI"],
      ["BBC"],
      "2026-08-12T23:50:00Z",
    );
  });

  it("never starts the pipeline (no claim, no ingest) when getLatestGeneratedAtForUser throws", async () => {
    mocks.getLatestGeneratedAtForUser.mockRejectedValue(
      new Error("connection reset"),
    );

    const { POST } = await import("@/app/api/digest/route");
    await expect(POST()).rejects.toThrow("connection reset");

    expect(mocks.claimDigestForGeneration).not.toHaveBeenCalled();
    expect(mocks.ingestArticles).not.toHaveBeenCalled();
    // No claim was ever taken, so there's nothing to release -- asserting
    // this guards against a future refactor accidentally calling release
    // unconditionally and masking a leaked claim elsewhere.
    expect(mocks.releaseDigestGeneration).not.toHaveBeenCalled();
  });

  it("still fetches the cursor even when this run turns out to be a no-op (claim already held)", async () => {
    // Regression guard: if a future refactor reordered these calls to only
    // fetch the cursor after a successful claim, that would be a behavior
    // change (and a wasted round trip either way) worth a test noticing.
    mocks.claimDigestForGeneration.mockResolvedValue(false);

    const { POST } = await import("@/app/api/digest/route");
    const res = await POST();

    expect(res.status).toBe(409);
    expect(mocks.getLatestGeneratedAtForUser).toHaveBeenCalledTimes(1);
    expect(mocks.ingestArticles).not.toHaveBeenCalled();
  });

  // The fix under test in this round: upsertDigestForToday and
  // getLatestGeneratedAtForUser now issue via Promise.all rather than one
  // sequential `await` after another. The tests below drive that concurrent
  // wiring directly rather than just re-checking the values that come out
  // the other end (already covered above).

  it("never starts the pipeline (no claim, no ingest, no release) when upsertDigestForToday throws -- the mirror case of getLatestGeneratedAtForUser throwing", async () => {
    mocks.upsertDigestForToday.mockRejectedValue(new Error("insert failed"));

    const { POST } = await import("@/app/api/digest/route");
    await expect(POST()).rejects.toThrow("insert failed");

    expect(mocks.claimDigestForGeneration).not.toHaveBeenCalled();
    expect(mocks.ingestArticles).not.toHaveBeenCalled();
    expect(mocks.releaseDigestGeneration).not.toHaveBeenCalled();
  });

  it("calls upsertDigestForToday and getLatestGeneratedAtForUser concurrently, not one after the other", async () => {
    // BOTH mocks are deferred, and that's the point. Deferring only the
    // upsert would leave this unable to tell Promise.all apart from a
    // sequential-but-reversed implementation (`await cursor` then `await
    // upsert`): the cursor mock would resolve immediately, the upsert would
    // block, and every assertion below would still hold — while the
    // round-trip the concurrency exists to save was never saved. With
    // neither able to settle, "both were called" is only reachable if both
    // were issued before either was awaited.
    let resolveUpsert!: (value: { digestId: string }) => void;
    let resolveCursor!: (value: string | null) => void;
    mocks.upsertDigestForToday.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    mocks.getLatestGeneratedAtForUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCursor = resolve;
        }),
    );

    const { POST } = await import("@/app/api/digest/route");
    const postPromise = POST();

    // Let POST() run as far as it can with neither promise settling. A
    // macrotask is the right instrument here: it runs only once the entire
    // microtask queue has drained, however deep, so this holds regardless of
    // how many awaits sit between POST()'s entry and the Promise.all.
    // Counting `await Promise.resolve()` ticks instead would work today and
    // silently need re-tuning the moment anything adds an await to the
    // auth/profile chain ahead of it — a magic number bound to unrelated code.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Positive counts, not absences: "hasn't been called yet" would pass
    // trivially against a too-shallow flush and prove nothing. Both HAVE
    // been called while both are still pending, which no serial ordering
    // can produce.
    expect(mocks.upsertDigestForToday).toHaveBeenCalledTimes(1);
    expect(mocks.getLatestGeneratedAtForUser).toHaveBeenCalledTimes(1);
    // And the claim must NOT have been taken yet -- it waits on BOTH
    // promises, not just whichever settles first.
    expect(mocks.claimDigestForGeneration).not.toHaveBeenCalled();

    // Settled in the opposite order to the array, so nothing here depends on
    // which of the two finishes first.
    resolveCursor("2026-07-31T10:00:00Z");
    resolveUpsert({ digestId: "digest-1" });
    await postPromise;

    expect(mocks.claimDigestForGeneration).toHaveBeenCalledWith(
      expect.anything(),
      "digest-1",
    );
  });

  it("surfaces upsertDigestForToday's rejection (not getLatestGeneratedAtForUser's) when both reject, and still takes no claim", async () => {
    // Documents actual Promise.all behavior for two already-rejected
    // promises built from `[upsertDigestForToday(...), getLatestGeneratedAtForUser(...)]`
    // in that order: the array's first element's rejection is the one that
    // wins. Not counting on this ordering anywhere in the app logic itself
    // (both branches behave identically -- no claim taken either way), but
    // pinning it down here means a future refactor that reorders the array
    // is a visible, deliberate choice instead of a silent behavior change.
    mocks.upsertDigestForToday.mockRejectedValue(new Error("upsert failed"));
    mocks.getLatestGeneratedAtForUser.mockRejectedValue(
      new Error("cursor failed"),
    );

    const { POST } = await import("@/app/api/digest/route");
    await expect(POST()).rejects.toThrow("upsert failed");

    expect(mocks.claimDigestForGeneration).not.toHaveBeenCalled();
    expect(mocks.releaseDigestGeneration).not.toHaveBeenCalled();
  });
});
