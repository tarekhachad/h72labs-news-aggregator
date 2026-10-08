import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { Card, Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { GenerationRejectedError } from "@/lib/claudeText";
import { RUN_FAILED_MESSAGE } from "@/lib/runFailure";
import { DIGEST_FAILED_MESSAGE } from "@/lib/ndjsonStream";
import { FAIL_CLOSED } from "@/lib/triageOutcome";

// Drives the REAL route POST handler. A run where a whole stage failed (every
// triage verdict, or every card) must end as an error without saving: saving
// is what moves the since-cursor, and a saved empty run would skip every
// article it read. A partial failure, or a quiet day with nothing to triage,
// still saves as before.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestUnits: vi.fn(),
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
vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestUnits: mocks.ingestUnits,
}));
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
  mocks.ingestUnits.mockResolvedValue([]);
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

async function run(): Promise<{ events: Array<Record<string, unknown>>; record: UsageRunRecord }> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(emitted).toHaveLength(1);
  return { events, record: emitted[0] };
}

function errorLogged(fragment: string): boolean {
  return vi
    .mocked(console.error)
    .mock.calls.some((args) => args.some((a) => String(a instanceof Error ? a.message : a).includes(fragment)));
}

describe("digest route: a run where a whole stage failed is not saved", () => {
  it("ends as an error, saves nothing and writes no card when every triage verdict failed closed", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1), cluster("b", 2), cluster("c", 1)]);
    mocks.triageClusters.mockResolvedValue([FAIL_CLOSED, FAIL_CLOSED, FAIL_CLOSED]);

    const { events, record } = await run();

    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(events.some((e) => e.stage === "done")).toBe(false);
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
    expect(mocks.writeCard).not.toHaveBeenCalled();
    expect(record.outcome).toBe("endedEarly");
    expect(record.triageFailedClosed).toBe(3);
    expect(errorLogged("every triage call failed (3/3 clusters unjudged)")).toBe(true);
  });

  it("still saves when only some triage verdicts failed closed", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1), cluster("b", 1)]);
    mocks.triageClusters.mockResolvedValue([FAIL_CLOSED, { notable: true, severity: 3 }]);
    mocks.writeCard.mockResolvedValue(card("b"));

    const { events, record } = await run();

    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
    expect(record.outcome).toBe("complete");
  });

  it("still saves when triage judged every cluster not notable", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1), cluster("b", 1)]);
    mocks.triageClusters.mockResolvedValue([
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
    ]);

    const { events } = await run();

    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
    expect(mocks.saveGeneratedCards.mock.calls[0][2]).toEqual([]);
  });

  it("still saves a quiet run with nothing to triage", async () => {
    mocks.clusterArticles.mockResolvedValue([]);
    mocks.triageClusters.mockResolvedValue([]);

    const { events } = await run();

    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });

  it("ends as an error and saves nothing when every card failed to write", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1), cluster("b", 2)]);
    mocks.writeCard.mockRejectedValue(new Anthropic.APIError(400, undefined, "credit balance is too low", new Headers()));

    const { events, record } = await run();

    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
    expect(record.outcome).toBe("endedEarly");
    expect(record.cardsFailed).toBe(2);
    expect(errorLogged("every card failed to write (0/2)")).toBe(true);
  });

  it("still saves when every card failed but the failures were refused responses, so a retry would repeat them", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([]);
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1)]);
    mocks.writeCard.mockRejectedValue(
      new GenerationRejectedError("m", "incompleteAfterRetry", "end_turn", "the leader's sister characterized the weapon as")
    );

    const { events, record } = await run();

    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
    expect(mocks.saveGeneratedCards.mock.calls[0][2]).toEqual([]);
    expect(record.outcome).toBe("complete");
    expect(record.cardsFailed).toBe(1);
  });

  it("still saves when every card failed with a mix of API errors and refused responses", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1), cluster("b", 2)]);
    mocks.writeCard.mockImplementation(async (c: Cluster) => {
      if (c.articles[0].title === "a") {
        throw new Anthropic.APIError(529, undefined, "overloaded", new Headers());
      }
      throw new GenerationRejectedError("m", "truncated", "max_tokens", "cut off");
    });

    const { events } = await run();

    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });

  it("still saves when only some cards failed", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1), cluster("b", 3)]);
    mocks.writeCard.mockImplementation(async (c: Cluster) => {
      if (c.articles[0].title === "b") {
        throw new GenerationRejectedError("m", "incompleteAfterRetry", "end_turn", "tail");
      }
      return card("a");
    });

    const { events } = await run();

    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });

  it("keeps the generic message for any other failure", async () => {
    mocks.clusterArticles.mockRejectedValue(new Error("embedding model failed to load"));

    const { events } = await run();

    expect(events.at(-1)).toEqual({ stage: "error", message: DIGEST_FAILED_MESSAGE });
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("never sends the failure's detail to the reader", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", 1)]);
    mocks.triageClusters.mockResolvedValue([FAIL_CLOSED]);

    const { events } = await run();

    expect(JSON.stringify(events)).not.toContain("unjudged");
  });
});
