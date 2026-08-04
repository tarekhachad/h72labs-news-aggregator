import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";

// Drives the REAL route.ts POST handler end-to-end (through the NDJSON
// stream) with every collaborator mocked, same pattern as
// dedup-wiring.test.ts. What's under test here is specifically the ranking
// wiring: does rankFrontPage get called (or correctly skipped) with the
// right merged candidate pool (existing cards + this run's new ones, in
// that order), does it run on every digest generation with new content
// (not gated like dedup), and are its results applied correctly (both
// existing cards and this run's new cards, via one atomic
// saveGeneratedCards call)?

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestArticles: vi.fn(),
  clusterArticles: vi.fn(),
  filterAlreadyCovered: vi.fn(),
  triageCluster: vi.fn(),
  writeCard: vi.fn(),
  rankFrontPage: vi.fn(),
  upsertDigestForToday: vi.fn(),
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

vi.mock("@/lib/triage", () => ({
  triageCluster: mocks.triageCluster,
}));

vi.mock("@/lib/writeCard", () => ({
  writeCard: mocks.writeCard,
}));

vi.mock("@/lib/rank", () => ({
  rankFrontPage: mocks.rankFrontPage,
}));

vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
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
        title: "A new story",
        snippet: "snippet",
        url: "https://example.com",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  },
];

const NEW_CARD: Card = {
  id: "card-new-1",
  topic: "Tech/AI",
  shortSummary: "new card summary",
  expandedReport: null,
  sources: [],
  publishedAt: "2026-07-31T12:00:00Z",
  generatedAt: "irrelevant-overwritten-by-route",
  bookmarked: false,
  severity: 4,
  frontPageRank: null,
};

const EXISTING_CARD_SUMMARY = {
  id: "card-existing-1",
  topic: "Tech/AI" as const,
  shortSummary: "existing card summary",
  severity: 2,
};

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
  mocks.getTodaysCardSummaries.mockResolvedValue([EXISTING_CARD_SUMMARY]);
  mocks.triageCluster.mockResolvedValue({ notable: true, severity: 4 });
  mocks.writeCard.mockResolvedValue(NEW_CARD);
  mocks.rankFrontPage.mockResolvedValue([3, 1]); // [existing card, new card]
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
});

async function runPostLines(): Promise<Array<Record<string, unknown>>> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// saveGeneratedCards(supabase, digestId, cards, generatedAt, existingRankUpdates)
function persistedCardsArg() {
  return mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
}
function existingRankUpdatesArg() {
  return mocks.saveGeneratedCards.mock.calls[0][4] as { id: string; frontPageRank: number | null }[];
}

describe("digest route: front-page ranking wiring", () => {
  it("calls rankFrontPage with the merged pool -- existing cards first, then this run's new cards, in that order", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: "2026-07-31T10:00:00Z",
    });

    await runPostLines();

    expect(mocks.rankFrontPage).toHaveBeenCalledTimes(1);
    expect(mocks.rankFrontPage).toHaveBeenCalledWith([
      { topic: "Tech/AI", severity: 2, text: "existing card summary" },
      { topic: "Tech/AI", severity: 4, text: "new card summary" },
    ]);
  });

  it("runs ranking even on the first digest of the day, unlike the dedup filter", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: null,
    });
    mocks.getTodaysCardSummaries.mockResolvedValue([]);

    await runPostLines();

    expect(mocks.filterAlreadyCovered).not.toHaveBeenCalled();
    expect(mocks.rankFrontPage).toHaveBeenCalledTimes(1);
  });

  it("still runs ranking even when this run produces zero new cards -- a card left unranked by an earlier run's failure must get another chance", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: "2026-07-31T10:00:00Z",
    });
    // Not notable -> writeCard never runs -> cards.length === 0 this run.
    // An earlier fix skipped ranking entirely in exactly this case, which
    // created a real bug: an existing card that a PRIOR run's rankFrontPage
    // failed to rank (frontPageRank stuck at null) could never be
    // reconsidered if every following run happened to add no new cards.
    // Ranking must still run here so that card gets re-evaluated.
    mocks.triageCluster.mockResolvedValue({ notable: false, severity: 1 });
    mocks.rankFrontPage.mockResolvedValue([2]); // ranks the one existing card

    const lines = await runPostLines();

    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");
    expect(mocks.rankFrontPage).toHaveBeenCalledTimes(1);
    expect(mocks.rankFrontPage).toHaveBeenCalledWith([
      { topic: "Tech/AI", severity: 2, text: "existing card summary" },
    ]);
    expect(existingRankUpdatesArg()).toEqual([{ id: "card-existing-1", frontPageRank: 2 }]);
  });

  it("skips ranking entirely (not just narrows the pool) when getTodaysCardSummaries fails -- an incomplete view of what's already ranked risks two cards colliding on the same rank", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: "2026-07-31T10:00:00Z",
    });
    mocks.getTodaysCardSummaries.mockRejectedValue(new Error("db blip"));

    const lines = await runPostLines();

    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");
    expect(mocks.rankFrontPage).not.toHaveBeenCalled();
    expect(existingRankUpdatesArg()).toEqual([]);
    expect(persistedCardsArg()[0].frontPageRank).toBeNull();
  });

  it("applies a successful rank result atomically: existing-card updates and this run's new cards' frontPageRank go through the SAME saveGeneratedCards call", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: "2026-07-31T10:00:00Z",
    });

    await runPostLines();

    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
    // Existing card demoted from whatever it was to rank 3.
    expect(existingRankUpdatesArg()).toEqual([{ id: "card-existing-1", frontPageRank: 3 }]);
    // New card gets rank 1 (rankFrontPage's second output slot), not the
    // null writeCard originally set it to.
    const persisted = persistedCardsArg();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].frontPageRank).toBe(1);
  });

  it("demotes a previously-ranked existing card back to null when this run's ranking no longer picks it, not just promotes", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: "2026-07-31T10:00:00Z",
    });
    // This run's ranking pass doesn't pick the existing card at all.
    mocks.rankFrontPage.mockResolvedValue([null, 1]);

    await runPostLines();

    expect(existingRankUpdatesArg()).toEqual([{ id: "card-existing-1", frontPageRank: null }]);
  });

  it("leaves existing ranks untouched (empty update list, not null-filled) and new cards at frontPageRank: null when rankFrontPage fails open (returns null)", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: "2026-07-31T10:00:00Z",
    });
    mocks.rankFrontPage.mockResolvedValue(null);

    const lines = await runPostLines();

    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");

    // Empty list, not [{ id: ..., frontPageRank: null }] -- an empty
    // jsonb_array_elements() update in persist_generated_cards is a
    // correct no-op, so an existing card's rank from an earlier
    // successful run is left exactly as it was, not cleared.
    expect(existingRankUpdatesArg()).toEqual([]);
    expect(persistedCardsArg()[0].frontPageRank).toBeNull();
  });

  it("still reaches done (not an error stage) if rankFrontPage itself throws, via route.ts's own defense-in-depth catch", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: "2026-07-31T10:00:00Z",
    });
    mocks.rankFrontPage.mockRejectedValue(new Error("unexpected failure"));

    const lines = await runPostLines();

    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });

  it("emits a 'ranking' stage event between writing and done", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({
      digestId: "digest-1",
      lastGeneratedAt: "2026-07-31T10:00:00Z",
    });

    const lines = await runPostLines();
    const stages = lines.map((l) => l.stage);

    expect(stages).toContain("ranking");
    expect(stages.indexOf("ranking")).toBeGreaterThan(stages.indexOf("writing"));
    expect(stages.indexOf("ranking")).toBeLessThan(stages.indexOf("done"));
  });
});
