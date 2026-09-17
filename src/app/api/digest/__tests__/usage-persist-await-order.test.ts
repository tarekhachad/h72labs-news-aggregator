import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";

// Adversarial regression test for a gap found while reviewing the digest
// route's usage-persistence wiring: `usage-persist-wiring.test.ts`'s mock
// sinks resolve with NO real asynchronous work (no await before their
// `emitted.push`), so a mutation that changes `await emitUsageRun(...)` in
// route.ts's finally block into a fire-and-forget call (`void
// emitUsageRun(...)`) passes that entire file's 20 tests -- because the
// synchronous portion of an async function body (everything before its
// first internal `await`) runs immediately when the function is CALLED, not
// deferred to a microtask, regardless of whether the caller awaits the
// returned promise. The mock sinks there have no internal await, so their
// side effect always lands before any assertion runs, awaited or not.
//
// This sink instead awaits one real macrotask tick (setTimeout) before
// pushing, the way a real Supabase insert or file write would. If route.ts's
// finally ever stops awaiting emitUsageRun, the generator's `finally` (and
// therefore the "done"/"error" branch's `events.return?.()` in
// toNdjsonStream, and therefore `controller.close()`) resolves BEFORE this
// sink settles -- so `res.text()` returns with the record still unpushed.
// That reproduces the exact production risk route.ts's own comments warn
// about: an unawaited promise can be frozen by the serverless runtime the
// moment the response is fully sent, silently dropping the very run that
// cost money.

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

// Spend caps are not under test here: every reservation is granted and every
// settle succeeds. spend-cap-wiring.test.ts covers them.
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({
      status: "ok",
      reservation: { id: "reservation-id", token: "settle-token", reservedUsd: 0.7 },
    })),
    settleSpend: vi.fn(async () => true),
  };
});

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
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue(FAKE_CLUSTERS);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
  // The load-bearing part of this test: a REAL macrotask delay before the
  // sink's side effect, unlike the sibling file's synchronous mock sinks.
  mocks.defaultUsageSinks.mockReturnValue([
    (record: UsageRunRecord) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          emitted.push(record);
          resolve();
        }, 0);
      }),
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

async function runPostToCompletion(): Promise<void> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
}

describe("digest route: the emit is genuinely awaited, not fire-and-forget", () => {
  it("has recorded the run by the time the response stream fully closes, even when the sink needs a real macrotask to settle", async () => {
    await runPostToCompletion();

    // If route.ts's finally ever stops awaiting emitUsageRun, the stream
    // closes (and res.text() resolves) before this sink's setTimeout fires,
    // and `emitted` is still empty here.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].userId).toBe("user-42");
  });
});
