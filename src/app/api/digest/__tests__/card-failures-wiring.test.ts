import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { Card, Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { GenerationRejectedError } from "@/lib/claudeText";
import { FAIL_CLOSED } from "@/lib/triageOutcome";

// Drives the REAL route POST handler and reads the run record it emits. What
// is under test is that a lost card and a fail-closed cluster each leave a
// stored reason. Both used to leave only a log line, and production logs
// expire within the hour, so the cause of a lost card could not be found
// after the fact.
//
// The failure record is built by position (`written[i]` against
// `notableClusters[i]`), so the attribution tests use clusters that differ
// in article count: a shifted index shows up as the wrong model and count.

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
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-09-23T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
    cs.map(() => ({ notable: true, severity: 3 }))
  );
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

describe("digest route: why a card was lost is recorded", () => {
  it("records an empty failure list and zero fail-closed on a clean run", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1)]);
    mocks.writeCard.mockResolvedValue(card("a"));

    const record = await runToCompletion();

    expect(record.cardsFailed).toBe(0);
    expect(record.cardFailures).toEqual([]);
    expect(record.triageFailedClosed).toBe(0);
  });

  it("records one entry per failed card, attributed to the cluster that failed, and still saves the rest", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1), cluster("b", 3), cluster("c", 1)]);
    mocks.writeCard.mockImplementation(async (c: Cluster) => {
      if (c.articles[0].title === "b") {
        throw new GenerationRejectedError("m", "incompleteAfterRetry", "end_turn", "ends with a dash —");
      }
      return card(c.articles[0].title);
    });

    const record = await runToCompletion();

    expect(record.cardsWritten).toBe(2);
    expect(record.cardsFailed).toBe(1);
    expect(record.cardFailures).toEqual([
      {
        reason: "incompleteAfterRetry",
        model: "claude-sonnet-5",
        articleCount: 3,
        stopReason: "end_turn",
        tail: "ends with a dash —",
      },
    ]);
    const saved = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(saved.map((c) => c.id).sort()).toEqual(["a", "c"]);
  });

  it("tells an API error apart from a refused response in the same run", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1), cluster("b", 2)]);
    mocks.writeCard.mockImplementation(async (c: Cluster) => {
      if (c.articles[0].title === "a") {
        throw new Anthropic.APIError(529, undefined, "overloaded", new Headers());
      }
      throw new GenerationRejectedError("m", "truncated", "max_tokens", "cut off mid");
    });

    const record = await runToCompletion();

    expect(record.cardsFailed).toBe(2);
    expect(record.cardFailures).toEqual([
      { reason: "apiError", model: "claude-haiku-4-5", articleCount: 1, status: 529 },
      {
        reason: "truncated",
        model: "claude-sonnet-5",
        articleCount: 2,
        stopReason: "max_tokens",
        tail: "cut off mid",
      },
    ]);
  });

  it("counts clusters triage failed closed, but not ones it judged not notable", async () => {
    mocks.clusterArticles.mockResolvedValue([
      cluster("a", 1),
      cluster("b", 1),
      cluster("c", 1),
      cluster("d", 1),
    ]);
    mocks.triageClusters.mockResolvedValue([
      FAIL_CLOSED,
      { notable: false, severity: 1 },
      FAIL_CLOSED,
      { notable: true, severity: 4 },
    ]);
    mocks.writeCard.mockResolvedValue(card("d"));

    const record = await runToCompletion();

    expect(record.triageFailedClosed).toBe(2);
    expect(record.cardsWritten).toBe(1);
  });

  it("leaves both null when the run ends before triage", async () => {
    mocks.clusterArticles.mockRejectedValue(new Error("embedding model failed to load"));

    const record = await runToCompletion();

    expect(record.outcome).toBe("endedEarly");
    expect(record.cardFailures).toBeNull();
    expect(record.triageFailedClosed).toBeNull();
  });
});
