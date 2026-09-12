import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";

// Adversarial probe: does cancelling the stream WHILE a pipeline stage is
// genuinely still in flight (not just after the whole pipeline has already
// settled, as usage-persist-wiring.test.ts's "records a cancelled run too"
// does with an instant no-op ingest) ever cause the generation mutex to be
// released more than once, or the usage record to be emitted more than
// once?
//
// The mechanism, stated precisely because two earlier versions of this
// comment got it wrong in opposite directions. toNdjsonStream's pull()
// awaits events.next(), and calls events.return?.() ONLY in its
// "done"/"error" branch. cancel() calls events.return?.() unconditionally.
// This test cancels mid-ingest, long before any "done" event exists, so on
// this path the contention is cancel()'s return() against the next() that
// the stream's second pull() has already issued -- one generator, two
// different methods, not two callers of return(). Per spec concurrent
// requests on a generator queue rather than interleave, but this project's
// own review checklist asks for that to be checked empirically rather than
// assumed from the spec.

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
  defaultUsageSinks: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/ingest", () => ({ ingestArticles: mocks.ingestArticles }));
vi.mock("@/lib/cluster", () => ({ clusterArticles: mocks.clusterArticles }));
vi.mock("@/lib/dedup", () => ({ filterAlreadyCovered: mocks.filterAlreadyCovered }));
vi.mock("@/lib/triage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  return { triageClusters: mocks.triageClusters, triageBatchCount: actual.triageBatchCount };
});
vi.mock("@/lib/writeCard", () => ({ writeCard: mocks.writeCard }));
vi.mock("@/lib/rank", () => ({ rankFrontPage: mocks.rankFrontPage }));
vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards,
  claimDigestForGeneration: mocks.claimDigestForGeneration,
  releaseDigestGeneration: mocks.releaseDigestGeneration,
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
}));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

import { recordCall } from "@/lib/usageCollector";

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
  title: "New card headline",
  shortSummary: "new card summary",
  labels: ["Tag"],
  expandedReport: null,
  sources: [],
  publishedAt: "2026-07-31T12:00:00Z",
  generatedAt: "irrelevant-overwritten-by-route",
  bookmarked: false,
  severity: 4,
  frontPageRank: null,
};

function usage(inputTokens: number) {
  return {
    input_tokens: inputTokens,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

let emitted: UsageRunRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Tech/AI"],
    preferredSources: ["BBC"],
  });
  mocks.clusterArticles.mockResolvedValue(FAKE_CLUSTERS);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);

  mocks.filterAlreadyCovered.mockImplementation(async (clusters: Cluster[]) => clusters);
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) => {
    await recordCall("triage", "claude-haiku-4-5", async () => ({ usage: usage(100) }));
    return cs.map(() => ({ notable: true, severity: 4 }));
  });
  mocks.writeCard.mockImplementation(async () => {
    await recordCall("writeCard", "claude-sonnet-5", async () => ({ usage: usage(1000) }));
    return NEW_CARD;
  });
  mocks.rankFrontPage.mockImplementation(async () => {
    await recordCall("rank", "claude-haiku-4-5", async () => ({ usage: usage(200) }));
    return [1];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("digest route: cancelling mid-stage races pull() and cancel() on the same generator", () => {
  it("releases the mutex and emits the record exactly once when the client cancels while ingest is still in flight", async () => {
    let resolveIngest: (v: unknown[]) => void = () => {};
    mocks.ingestArticles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIngest = resolve;
        })
    );

    const { POST } = await import("@/app/api/digest/route");
    const res = await POST();
    const reader = res.body!.getReader();

    // Pull the first chunk (the "ingesting" stage event) so pull() is
    // genuinely mid-flight, awaiting ingestArticles, when we cancel.
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);

    // Assert the premise rather than assuming it. This test's whole value
    // rests on the generator being genuinely suspended INSIDE ingestArticles
    // when cancel() lands -- that is what makes cancel()'s events.return?.()
    // contend with the generator's already-pending events.next(), issued by
    // the stream's second pull(). (On THIS path only cancel() calls return():
    // pull() has a return() call of its own, but it sits in the "done"/"error"
    // branch, which a mid-ingest cancellation never reaches. So the race is
    // next() against return() on one generator, not two callers of return().)
    // If the stream did not auto-pull after the first read, the generator
    // would instead still be parked at its first yield, cancel() would be
    // uncontended, and this test would pass while exercising nothing. Waiting
    // on it also removes the timing assumption: the race is set up
    // deterministically instead of hopefully.
    await vi.waitFor(() => expect(mocks.ingestArticles).toHaveBeenCalled());

    // Cancel now, WHILE ingestArticles is still unresolved. The first pull()
    // already handed back a chunk; the second one is parked in events.next(),
    // which is what resumed the generator into ingestArticles. So this pits
    // cancel()'s events.return?.() against that pending next(), on the same
    // generator.
    const cancelPromise = reader.cancel();

    // Let ingestArticles resolve after cancellation has been requested, the
    // way a real in-flight API call would outlive a client disconnect.
    resolveIngest([]);

    await cancelPromise;
    await vi.waitFor(() => expect(mocks.releaseDigestGeneration).toHaveBeenCalled());
    // Give any stray extra async work a chance to surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);
  });
});
