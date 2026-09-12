import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";

// Adversarial gap-fill: usage-persist-wiring.test.ts's "gives each run its
// own id" test runs two POSTs SEQUENTIALLY (`await`ed one after the other),
// which can never exercise cross-delivery -- the second run's `shape`,
// `usage` collector and generator closure don't even exist yet while the
// first is finishing. The review checklist explicitly asks for concurrent
// runs to be checked, and nothing in this suite drives two digest runs
// truly concurrently the way expand-usage-wiring.test.ts's "keeps two
// concurrent expands from merging their spend" does for the sibling route.
// This file is that missing counterpart.
//
// Each user gets a distinctly-shaped run (different topic counts, different
// cluster counts, different cap behaviour) specifically so a cross-delivery
// bug -- e.g. a `shape` object accidentally hoisted to module scope, or an
// AsyncLocalStorage scope leaking between concurrent generator instances --
// would produce a record with the WRONG numbers attributed to the wrong
// user, not just the right count of records.

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

function clustersFor(topic: string, n: number): Cluster[] {
  return Array.from({ length: n }, (_, i) => ({
    topic: topic as Cluster["topic"],
    articles: [
      {
        title: `${topic}-${i}`,
        snippet: "snippet",
        url: `https://example.com/${topic}-${i}`,
        source: "BBC",
        topic: topic as Cluster["topic"],
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  }));
}

function cardFor(c: Cluster, severity: number): Card {
  return {
    id: `card-${c.articles[0].title}`,
    topic: c.topic,
    title: c.articles[0].title,
    shortSummary: "summary",
    labels: ["Tag"],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-07-31T12:00:00Z",
    generatedAt: "overwritten",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

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

  mocks.ingestArticles.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
  mocks.rankFrontPage.mockImplementation(async () => {
    await recordCall("rank", "claude-haiku-4-5", async () => ({ usage: usage(50) }));
    return null;
  });
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => {
    // A real per-call macrotask delay -- the point of this file is to
    // interleave two runs' async work, not just their synchronous setup.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await recordCall("writeCard", "claude-sonnet-5", async () => ({ usage: usage(1000) }));
    return cardFor(c, severity);
  });
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      emitted.push(record);
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runPostAs(userId: string, digestId: string, topics: string[], clusters: Cluster[]) {
  mocks.getUser.mockResolvedValueOnce({ data: { user: { id: userId } } });
  mocks.getUserProfile.mockImplementationOnce(async () => ({
    topics: topics as never[],
    preferredSources: ["BBC"] as never[],
  }));
  mocks.upsertDigestForToday.mockImplementationOnce(async () => ({ digestId }));
  mocks.clusterArticles.mockImplementationOnce(async () => clusters);
  mocks.triageClusters.mockImplementationOnce(async (cs: Cluster[]) => {
    await recordCall("triage", "claude-haiku-4-5", async () => ({ usage: usage(100) }));
    return cs.map(() => ({ notable: true, severity: 3 }));
  });
  mocks.filterAlreadyCovered.mockImplementationOnce(async (cs: Cluster[]) => cs);

  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
}

describe("digest route: two truly concurrent runs (different users) never cross-deliver", () => {
  it("attributes each run's own userId, digestId and shape to its own record", async () => {
    await Promise.all([
      runPostAs("user-A", "digest-A", ["Tech/AI"], clustersFor("Tech/AI", 3)),
      runPostAs("user-B", "digest-B", ["Tech/AI", "Morocco", "World"], clustersFor("Morocco", 7)),
    ]);

    expect(emitted).toHaveLength(2);

    const forA = emitted.find((r) => r.userId === "user-A");
    const forB = emitted.find((r) => r.userId === "user-B");
    expect(forA).toBeDefined();
    expect(forB).toBeDefined();

    expect(forA!.digestId).toBe("digest-A");
    expect(forA!.topicCount).toBe(1);
    expect(forA!.clusterCount).toBe(3);
    expect(forA!.cardsWritten).toBe(3);

    expect(forB!.digestId).toBe("digest-B");
    expect(forB!.topicCount).toBe(3);
    expect(forB!.clusterCount).toBe(7);
    expect(forB!.cardsWritten).toBe(7);

    // Neither run's totals bled into the other's -- each billed exactly its
    // own writeCard calls (plus one triage batch and one rank call), not the
    // union of both runs' work.
    expect(forA!.totalCalls).toBe(1 + 3 + 1); // triage + 3 writeCard + rank
    expect(forB!.totalCalls).toBe(1 + 7 + 1); // triage + 7 writeCard + rank

    expect(forA!.runId).not.toBe(forB!.runId);
  });
});
