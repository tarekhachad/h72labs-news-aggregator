import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Cluster } from "@/types";

// cursor-wiring.test.ts pins the cursor wiring for a SINGLE call to POST,
// each test independently choosing what getLatestGeneratedAtForUser resolves
// to. That leaves an untested seam this round's brief calls out explicitly:
// what the cursor actually is across a SEQUENCE of same-day runs, where each
// run's own generatedAt becomes the next run's cursor (via
// saveGeneratedCards -> persist_generated_cards advancing last_generated_at,
// which getLatestGeneratedAtForUser then reads back). This file drives POST
// three times in a row against the same simulated user/day, manually
// advancing the mocked cursor between calls the way the real DB round-trip
// would, and asserts each run's ingestArticles call sees the PREVIOUS run's
// stamp -- not the first run's, not null, and not something stale.

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
        publishedAt: "2026-08-13T09:00:00Z",
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
  mocks.filterAlreadyCovered.mockImplementation(
    async (clusters: Cluster[]) => clusters,
  );
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
    cs.map(() => ({ notable: false, severity: 1 })),
  );
  mocks.writeCard.mockResolvedValue(undefined);
  mocks.rankFrontPage.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  // Same digestId across all three runs -- same calendar day, same user,
  // same (user_id, date) row per upsertDigestForToday's unique constraint.
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-today" });
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
});

async function runPost() {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
}

describe("digest route: cursor across a sequence of same-day runs", () => {
  it("run 2 sees run 1's stamp, and run 3 sees run 2's -- never the first run's cursor replayed and never null", async () => {
    // Run 1: a returning user, last generated yesterday evening.
    mocks.getLatestGeneratedAtForUser.mockResolvedValueOnce(
      "2026-08-12T22:00:00.000Z",
    );
    await runPost();
    expect(mocks.ingestArticles).toHaveBeenNthCalledWith(
      1,
      ["Tech/AI"],
      ["BBC"],
      "2026-08-12T22:00:00.000Z",
    );

    // Run 1 "finished" and (via persist_generated_cards) advanced
    // digest-today's last_generated_at to this run's own generatedAt. The
    // next call to getLatestGeneratedAtForUser must reflect that, not the
    // value run 1 itself was given.
    mocks.getLatestGeneratedAtForUser.mockResolvedValueOnce(
      "2026-08-13T10:00:00.000Z",
    );
    await runPost();
    expect(mocks.ingestArticles).toHaveBeenNthCalledWith(
      2,
      ["Tech/AI"],
      ["BBC"],
      "2026-08-13T10:00:00.000Z",
    );

    // Run 3: same pattern, one more advance. A regression that re-derived
    // the cursor from something fixed at request-sequence start (rather
    // than re-querying fresh each time) would replay run 2's -- or run 1's
    // -- value here instead.
    mocks.getLatestGeneratedAtForUser.mockResolvedValueOnce(
      "2026-08-13T11:30:00.000Z",
    );
    await runPost();
    expect(mocks.ingestArticles).toHaveBeenNthCalledWith(
      3,
      ["Tech/AI"],
      ["BBC"],
      "2026-08-13T11:30:00.000Z",
    );

    expect(mocks.ingestArticles).toHaveBeenCalledTimes(3);
    // Every run wrote into the SAME digest row -- this is same-day
    // multi-run, not a new row per run.
    expect(mocks.claimDigestForGeneration).toHaveBeenCalledTimes(3);
    for (const call of mocks.claimDigestForGeneration.mock.calls) {
      expect(call[1]).toBe("digest-today");
    }
  });

  it("run 3 sees existing cards accumulated from BOTH prior runs when dedup-gating on getTodaysCardSummaries", async () => {
    // Not asserting getTodaysCardSummaries' own accumulation logic (that's
    // a DB-level concern outside this function's scope) -- asserting that
    // the route re-fetches it fresh on every run rather than caching run
    // 1's snapshot, so a growing list is actually visible to run 3's dedup
    // gate.
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(
      "2026-08-13T09:00:00.000Z",
    );

    mocks.getTodaysCardSummaries.mockResolvedValueOnce([]);
    await runPost();
    expect(mocks.filterAlreadyCovered).not.toHaveBeenCalled();

    mocks.getTodaysCardSummaries.mockResolvedValueOnce([
      {
        id: "c1",
        topic: "Tech/AI" as const,
        shortSummary: "run 1's card",
        severity: 2,
      },
    ]);
    await runPost();
    expect(mocks.filterAlreadyCovered).toHaveBeenCalledTimes(1);

    mocks.getTodaysCardSummaries.mockResolvedValueOnce([
      {
        id: "c1",
        topic: "Tech/AI" as const,
        shortSummary: "run 1's card",
        severity: 2,
      },
      {
        id: "c2",
        topic: "Tech/AI" as const,
        shortSummary: "run 2's card",
        severity: 3,
      },
    ]);
    await runPost();
    expect(mocks.filterAlreadyCovered).toHaveBeenCalledTimes(2);
    expect(mocks.filterAlreadyCovered).toHaveBeenLastCalledWith(
      FAKE_CLUSTERS,
      expect.arrayContaining([
        expect.objectContaining({ id: "c1" }),
        expect.objectContaining({ id: "c2" }),
      ]),
    );

    expect(mocks.getTodaysCardSummaries).toHaveBeenCalledTimes(3);
  });
});
