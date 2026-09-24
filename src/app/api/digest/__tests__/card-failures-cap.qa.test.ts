import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { GenerationRejectedError } from "@/lib/claudeText";

// The failure record is built by position: `written[i]` against
// `notableClusters[i]`, where `notableClusters` is the CAP-APPLIED,
// possibly-reordered list -- not the pre-cap `triaged` list and not the
// original `survivingClusters` order. This drives the real route with a real
// applyCardCap pass (triageClusters is mocked, applyCardCap is NOT) to prove
// a card lost among the clusters the cap actually kept is attributed to the
// right cluster, and a cluster the cap dropped never shows up in
// cardFailures at all -- it was never sent to writeCard, so counting it as a
// "failure" would double-blame the same missing card under two different
// reasons (dropped-by-cap AND write-failed).

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
  claimGenerationForUser: vi.fn(),
  releaseGenerationClaim: vi.fn(),
  getTodaysCardSummaries: vi.fn(),
  defaultUsageSinks: vi.fn(),
}));

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
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
}));
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser,
  releaseGenerationClaim: mocks.releaseGenerationClaim,
}));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

function cluster(title: string, articleCount: number): Cluster {
  return {
    topic: "Tech/AI",
    articles: Array.from({ length: articleCount }, (_, i) => ({
      title: i === 0 ? title : `${title} (source ${i + 1})`,
      snippet: "snippet",
      url: `https://example.com/${title}/${i}`,
      source: "BBC",
      topic: "Tech/AI" as const,
      publishedAt: "2026-09-24T12:00:00Z",
    })),
  };
}

function card(id: string): Card {
  return {
    id,
    topic: "Tech/AI",
    title: `Headline ${id}`,
    shortSummary: "A summary.",
    labels: ["Tag"],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-09-24T12:00:00Z",
    generatedAt: "overwritten-by-route",
    bookmarked: false,
    severity: 3,
    frontPageRank: null,
  };
}

let emitted: UsageRunRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI"], preferredSources: ["BBC"] });
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  // sinceIso non-null + zero existing cards -> firstOfDay -> the 8-per-topic
  // first-run allowance (see cardCap.ts's FIRST_RUN_CARDS_PER_TOPIC), so 9
  // same-topic notable clusters is exactly one over the cap.
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-09-23T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runToCompletion(): Promise<UsageRunRecord> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
  expect(emitted).toHaveLength(1);
  return emitted[0];
}

describe("digest route: card-cap interaction with card-failure attribution", () => {
  it("attributes a lost card only to a cluster the cap actually kept, and never to the one it dropped", async () => {
    // 9 notable clusters, one per severity 1..9 (severity 9 is out of the
    // real 1-5 range but the mock triage stub can hand back anything -- only
    // relative ordering matters to applyCardCap's ranking). The cap keeps
    // the 8 highest-severity clusters and drops the severity-1 one.
    const clusters = Array.from({ length: 9 }, (_, i) => cluster(`c${i}`, i === 4 ? 3 : 1));
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
      cs.map((c) => ({ notable: true, severity: c.articles[0].title === "c0" ? 1 : 5 }))
    );
    // Fail the write for the cluster with 3 articles (c4) -- distinguishable
    // by both title and article count from every other cluster, so a
    // shifted index shows up as the wrong model/articleCount/title.
    mocks.writeCard.mockImplementation(async (c: Cluster) => {
      if (c.articles[0].title === "c4") {
        throw new GenerationRejectedError("m", "truncated", "max_tokens", "cut off");
      }
      return card(c.articles[0].title);
    });

    const record = await runToCompletion();

    expect(record.cardsDroppedByCap).toBe(1);
    expect(record.cardsFailed).toBe(1);
    expect(record.cardFailures).toEqual([
      {
        reason: "truncated",
        model: "claude-sonnet-5",
        articleCount: 3,
        stopReason: "max_tokens",
        tail: "cut off",
      },
    ]);
    // c0 (severity 1, dropped by the cap) must never reach writeCard, so it
    // cannot appear as a failure either -- it is accounted for once, as a
    // cap drop, not twice.
    expect(mocks.writeCard).not.toHaveBeenCalledWith(
      expect.objectContaining({ articles: expect.arrayContaining([expect.objectContaining({ title: "c0" })]) }),
      expect.anything()
    );
    expect(record.cardsWritten).toBe(7);
  });
});
