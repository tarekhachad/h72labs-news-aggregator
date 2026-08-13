import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Cluster } from "@/types";

// This test drives the REAL route.ts POST handler end-to-end (through the
// NDJSON stream) with every collaborator mocked, so we can assert on real
// call counts rather than just re-reading the source. The one thing under
// test is the wiring in runDigestPipeline: does the dedup step
// (filterAlreadyCovered / getTodaysCardSummaries) actually get invoked --
// or fully skipped -- based on whether there are existing cards to compare
// against, not just "cheaply" short-circuited.
//
// The gate used to be sinceIso !== null. F.4.4 made the since-cursor carry
// across days, so a new day's first run now has a non-null cursor and zero
// existing cards -- the two stopped coinciding, and the gate moved to the
// condition it always actually meant.

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
  // Not notable -> skips writeCard entirely, keeping the rest of the
  // pipeline trivial for this wiring-focused test.
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
    cs.map(() => ({ notable: false, severity: 1 })),
  );
  mocks.writeCard.mockResolvedValue(undefined);
  // Empty candidate pool by default (no existing cards, no notable clusters
  // in this suite's trivial setup) -- irrelevant to what these tests assert.
  mocks.rankFrontPage.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  // A returning user by default -- the cursor no longer decides whether
  // dedup runs, so tests that care set getTodaysCardSummaries instead.
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
});

async function runPost() {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  // Fully drains the NDJSON stream, driving the async generator to
  // completion (including its finally block).
  await res.text();
}

// Same as runPost(), but returns the parsed NDJSON lines so tests can assert
// on the actual stream contents (e.g. confirming no "error" stage was
// emitted, and that a "done" stage was reached) rather than just that the
// call didn't throw.
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

describe("digest route: dedup step wiring on first run vs. later runs", () => {
  it("fully skips the dedup filter step when there are no existing cards to compare against, but still fetches them for ranking", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([]);

    await runPost();

    expect(mocks.filterAlreadyCovered).not.toHaveBeenCalled();
    // Unlike filterAlreadyCovered, getTodaysCardSummaries isn't gated at all
    // -- the front-page ranking pass needs today's existing cards on every
    // run, including the first, so this always fires (it's just guaranteed
    // to resolve empty on the first run of a day).
    expect(mocks.getTodaysCardSummaries).toHaveBeenCalledTimes(1);
    // The clusters produced by clusterArticles should flow straight through
    // to triage unfiltered when the dedup filter itself is skipped.
    expect(mocks.triageClusters).toHaveBeenCalledWith(FAKE_CLUSTERS);
  });

  it("skips dedup on a new day's first run even though the since-cursor is now non-null", async () => {
    // The regression guard for F.4.4's gate change: a returning user's
    // cursor points at yesterday, so the old `sinceIso !== null` gate would
    // fire here against an empty card list.
    mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-30T22:00:00Z");
    mocks.getTodaysCardSummaries.mockResolvedValue([]);

    await runPost();

    expect(mocks.filterAlreadyCovered).not.toHaveBeenCalled();
    expect(mocks.triageClusters).toHaveBeenCalledWith(FAKE_CLUSTERS);
  });

  it("runs the dedup step on a later same-day run (existing cards present)", async () => {
    const existing = [
      { topic: "Tech/AI" as const, shortSummary: "existing card" },
    ];
    mocks.getTodaysCardSummaries.mockResolvedValue(existing);

    await runPost();

    expect(mocks.getTodaysCardSummaries).toHaveBeenCalledTimes(1);
    expect(mocks.getTodaysCardSummaries).toHaveBeenCalledWith(
      expect.anything(),
      "digest-1",
    );
    expect(mocks.filterAlreadyCovered).toHaveBeenCalledTimes(1);
    expect(mocks.filterAlreadyCovered).toHaveBeenCalledWith(
      FAKE_CLUSTERS,
      existing,
    );
  });

  it("still releases the generation claim when the dedup step is skipped", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([]);

    await runPost();

    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });
});

describe("digest route: dedup step failure falls back to un-deduplicated clusters", () => {
  it("degrades to skipping dedup (not failing the run) when getTodaysCardSummaries throws", async () => {
    mocks.getTodaysCardSummaries.mockRejectedValue(new Error("db blip"));

    const lines = await runPostLines();

    // The whole request must still succeed end to end -- no error stage,
    // and it reaches "done" -- instead of the thrown exception propagating
    // and failing the entire digest generation.
    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");

    // The fetch failure is caught by its own dedicated try/catch, separate
    // from the dedup filter's -- existingCards falls back to [], which the
    // gate then reads as "nothing to compare against." Previously this
    // called filterAlreadyCovered with an empty list, which its own
    // documented early return made a no-op; skipping is the same behaviour
    // decided one level up. Either way the clusters reach triage intact.
    expect(mocks.filterAlreadyCovered).not.toHaveBeenCalled();
    expect(mocks.triageClusters).toHaveBeenCalledWith(FAKE_CLUSTERS);

    // The generation-mutex claim must still be released even on this
    // caught-internally failure path.
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });

  it("completes the digest using original clusters when filterAlreadyCovered throws (e.g. an embedding failure)", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { topic: "Tech/AI", shortSummary: "existing card" },
    ]);
    mocks.filterAlreadyCovered.mockRejectedValue(
      new Error("embedding model failure"),
    );

    const lines = await runPostLines();

    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");

    // filterAlreadyCovered was called (and threw) -- confirm the caller
    // actually attempted dedup, not that it was skipped for some other
    // reason.
    expect(mocks.filterAlreadyCovered).toHaveBeenCalledTimes(1);
    // Despite the throw, the original un-deduplicated clusters must still
    // reach triage.
    expect(mocks.triageClusters).toHaveBeenCalledWith(FAKE_CLUSTERS);
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });
});
