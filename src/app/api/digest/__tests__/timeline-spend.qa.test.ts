import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, type Card, type Cluster, type Source, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import type { StoryCandidate } from "@/lib/storyTimeline";
import { settleSpend } from "@/lib/spend";

// The story timeline's effect on what a digest run settles its spend at,
// through the REAL route, the REAL matching and the REAL settle arithmetic,
// with the model, the SDK and the database mocked: a run whose checks all
// answered settles at its exact total, one whose checks failed settles at a
// proven ceiling below the reservation, and a run that fails while checks are
// out still counts them.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestUnits: vi.fn(),
  clusterArticles: vi.fn(),
  triageClusters: vi.fn(),
  writeCard: vi.fn(),
  rankFrontPage: vi.fn(),
  upsertDigestForToday: vi.fn(),
  getLatestGeneratedAtForUser: vi.fn(),
  saveGeneratedCards: vi.fn(),
  getStoryTimelines: vi.fn(),
  claimGenerationForUser: vi.fn(),
  releaseGenerationClaim: vi.fn(),
  getTodaysCardSummaries: vi.fn(),
  defaultUsageSinks: vi.fn(),
  loadStoryCandidates: vi.fn(),
  countPreferredSources: vi.fn(),
  parse: vi.fn(),
  embed: vi.fn(),
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
const SUPABASE = { auth: { getUser: (...args: unknown[]) => mocks.getUser(...args) } };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => SUPABASE) }));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestUnits: mocks.ingestUnits,
}));
vi.mock("@/lib/cluster", () => ({ clusterArticles: mocks.clusterArticles }));
vi.mock("@/lib/dedup", () => ({ filterAlreadyCovered: vi.fn(async (cs: Cluster[]) => cs) }));
vi.mock("@/lib/triage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  return { triageClusters: mocks.triageClusters, triageBatchCount: actual.triageBatchCount };
});
vi.mock("@/lib/writeCard", () => ({ writeCard: mocks.writeCard }));
vi.mock("@/lib/rank", () => ({ rankFrontPage: mocks.rankFrontPage }));
vi.mock("@/lib/preferredSources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/preferredSources")>()),
  countPreferredSources: mocks.countPreferredSources,
}));
vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards,
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
  getStoryTimelines: mocks.getStoryTimelines,
}));
vi.mock("@/lib/storyTimeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storyTimeline")>()),
  loadStoryCandidates: mocks.loadStoryCandidates,
}));
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser,
  releaseGenerationClaim: mocks.releaseGenerationClaim,
}));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mocks.parse }, maxRetries: 0 };
  }
  return { default: FakeAnthropic };
});
vi.mock("@/lib/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/embeddings")>("@/lib/embeddings");
  return { embed: mocks.embed, cosineSimilarity: actual.cosineSimilarity };
});

const [OTHER] = SOURCES.slice(0, 1) as Source[];
const VECTOR = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const TODAY = "2026-10-13";

function cluster(label: string, topic: Topic): Cluster {
  return {
    topic,
    articles: [{ title: label, snippet: "", url: `https://example.com/${label}`, source: OTHER, topic, publishedAt: "2026-10-13T08:00:00Z" }],
  };
}

function cardFor(c: Cluster, severity: number): Card {
  return {
    id: `card-${c.articles[0].title}`,
    topic: c.topic,
    title: c.articles[0].title,
    shortSummary: `summary ${c.articles[0].title}`,
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-13T08:00:00Z",
    generatedAt: "overwritten-by-route",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

const EARLIER: StoryCandidate = {
  id: "old-card",
  storyId: "story-1",
  date: "2026-10-10",
  title: "Talks open in Doha",
  shortSummary: "Negotiators met.",
  embedding: VECTOR,
};

let emitted: UsageRunRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Geopolitics", "Football", "Space"], preferredSources: [], countries: [], timeZone: "UTC" });
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1", date: TODAY });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-12T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.countPreferredSources.mockReturnValue(0);
  mocks.clusterArticles.mockResolvedValue([cluster("ceasefire", "Geopolitics"), cluster("match", "Football")]);
  mocks.triageClusters.mockResolvedValue([
    { notable: true, severity: 4 },
    { notable: true, severity: 3 },
  ]);
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => cardFor(c, severity));
  // The ceasefire card points at the earlier story; the match card points away.
  mocks.embed.mockImplementation(async (texts: string[]) =>
    texts.map((t) => (t.startsWith("ceasefire") ? VECTOR : Array.from({ length: 384 }, (_, i) => (i === 1 ? 1 : 0))))
  );
  mocks.loadStoryCandidates.mockResolvedValue([EARLIER]);
  mocks.parse.mockResolvedValue({ parsed_output: { match: 1 }, stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 7 } });
  mocks.getStoryTimelines.mockImplementation(async (_s: unknown, _u: string, subjects: { id: string; storyId: string | null }[]) =>
    new Map(
      subjects
        .filter((s) => s.storyId === "story-1")
        .map((s) => [s.id, { day: 2, earlier: [{ id: "old-card", date: "2026-10-10", title: "Talks open in Doha", topic: "Geopolitics" }] }])
    )
  );
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
});

afterEach(() => vi.restoreAllMocks());

async function run(): Promise<{ events: Record<string, unknown>[]; record: UsageRunRecord }> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(emitted).toHaveLength(1);
  return { events, record: emitted[0] };
}


const RESERVED = 0.7;
const settledAt = () => (settleSpend as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as number | null;
const ok = { parsed_output: { match: 1 }, stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 7 } };

// The harness's stage mocks make no recorded calls, which on its own floors
// every run; here each records the calls the route expects of it, so the
// timeline is the only stage that can move the settle.
const STAGE_USAGE = { input_tokens: 1000, output_tokens: 100 };
async function recordStage(stage: "triage" | "writeCard" | "rank", model: "claude-haiku-4-5" | "claude-sonnet-5") {
  const { recordCall } = await vi.importActual<typeof import("@/lib/usageCollector")>("@/lib/usageCollector");
  await recordCall(stage, model, async () => ({ usage: STAGE_USAGE }));
}
beforeEach(async () => {
  const { triageBatchCount } = await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  mocks.triageClusters.mockImplementation(async (clusters: Cluster[]) => {
    for (let i = 0; i < triageBatchCount(clusters); i++) await recordStage("triage", "claude-haiku-4-5");
    return clusters.map(() => ({ notable: true, severity: 3 }));
  });
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => {
    await recordStage("writeCard", "claude-sonnet-5");
    return cardFor(c, severity);
  });
  mocks.rankFrontPage.mockImplementation(async () => {
    await recordStage("rank", "claude-haiku-4-5");
    return null;
  });
});

describe("digest route: the timeline and the spend settle", () => {
  it("settles a run whose checks all answered at its exact total, not floored", async () => {
    const { record } = await run();
    expect(record.isFloor).toBe(false);
    expect(record.stages.find((s) => s.stage === "timeline")).toMatchObject({ calls: 1, callsWithoutUsage: 0 });
    expect(settledAt()).toBeCloseTo(record.totalBilledUsd, 12);
    expect(settledAt()!).toBeLessThan(RESERVED);
  });

  it("settles a run whose checks all failed at a proven ceiling below the reservation", async () => {
    const many = Array.from({ length: 20 }, (_, i) => cluster(`ceasefire-${i}`, "Geopolitics"));
    mocks.clusterArticles.mockResolvedValue(many);
    mocks.parse.mockRejectedValue(new Error("529 overloaded"));
    const { events, record } = await run();
    expect(events.at(-1)?.stage).toBe("done");
    const stage = record.stages.find((s) => s.stage === "timeline");
    expect(stage).toMatchObject({ calls: 0 });
    expect(stage?.callsWithoutUsage).toBe(mocks.parse.mock.calls.length);
    expect(mocks.parse.mock.calls.length).toBeGreaterThan(0);
    expect(record.isFloor).toBe(true);
    const settled = settledAt();
    expect(settled).not.toBeNull();
    expect(settled!).toBeGreaterThan(record.totalBilledUsd);
    expect(settled!).toBeLessThan(RESERVED);
  });

  it("counts checks still out when ranking fails, so the failed run settles at its total rather than the reservation", async () => {
    mocks.parse.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ok), 30)));
    mocks.rankFrontPage.mockImplementation(async () => {
      await recordStage("rank", "claude-haiku-4-5");
      return new Proxy([], {
        get(target, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) throw new Error("bad rank result");
          return Reflect.get(target, key);
        },
      });
    });
    const { events, record } = await run();
    expect(events.at(-1)?.stage).toBe("error");
    expect(record.stages.find((s) => s.stage === "timeline")).toMatchObject({ calls: 1 });
    expect(record.isFloor).toBe(false);
    expect(settledAt()).toBeCloseTo(record.totalBilledUsd, 12);
  });

  it("settles a failed save at the total including the checks it made", async () => {
    mocks.saveGeneratedCards.mockRejectedValue(new Error("save failed"));
    const { events, record } = await run();
    expect(events.at(-1)?.stage).toBe("error");
    expect(record.stages.find((s) => s.stage === "timeline")).toMatchObject({ calls: 1 });
    expect(record.isFloor).toBe(false);
    expect(settledAt()).toBeCloseTo(record.totalBilledUsd, 12);
  });
});
