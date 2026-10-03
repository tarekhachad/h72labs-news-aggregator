import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, TOPICS, type Card, type Cluster, type Source, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { FAIL_CLOSED, type TriageOutcome } from "@/lib/triageOutcome";
import { MAX_TOPICS_PER_DIGEST, planFeeds, MAX_FEEDS_PER_TOPIC } from "@/lib/ingest";
import { MAX_SEVERITY } from "@/lib/preferredSources";

// QA round 1: the digest route with optional preferred sources. Drives the
// REAL POST handler; everything that would touch the network, Claude or the
// database is mocked. Never names a topic or an outlet.

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
  reserveSpend: vi.fn(),
}));

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return { ...actual, reserveSpend: mocks.reserveSpend, settleSpend: vi.fn(async () => true) };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestArticles: mocks.ingestArticles,
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

const TOPIC = TOPICS[0] as Topic;
const [PICKED, OTHER] = SOURCES.slice(0, 2) as Source[];

function cluster(label: string, sources: Source[], topic: Topic = TOPIC): Cluster {
  return {
    topic,
    articles: sources.map((source, i) => ({
      title: i === 0 ? label : `${label} (${i})`,
      snippet: "",
      url: `https://example.com/${label}/${i}`,
      source,
      topic,
      publishedAt: "2026-10-02T12:00:00Z",
    })),
  };
}

function cardFor(c: Cluster, severity: number): Card {
  return {
    id: `card-${c.articles[0].title}`,
    topic: c.topic,
    title: c.articles[0].title,
    shortSummary: `summary ${c.articles[0].title}`,
    labels: ["Tag"],
    expandedReport: null,
    sources: c.articles.map(({ title, url, source, snippet }) => ({ title, url, source, snippet })),
    publishedAt: "2026-10-02T12:00:00Z",
    generatedAt: "x",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

let emitted: UsageRunRecord[];
const setProfile = (preferredSources: Source[], topics: Topic[] = [TOPIC]) =>
  mocks.getUserProfile.mockResolvedValue({ topics, preferredSources, timeZone: "UTC" });
const triageReturns = (o: TriageOutcome[]) => mocks.triageClusters.mockResolvedValue(o);
const written = () =>
  (mocks.writeCard.mock.calls as [Cluster, number][]).map(([c, s]) => [c.articles[0].title, s]);

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  setProfile([PICKED]);
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue([]);
  triageReturns([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-01T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.writeCard.mockImplementation(async (c: Cluster, s: number) => cardFor(c, s));
  mocks.reserveSpend.mockResolvedValue({
    status: "ok",
    reservation: { id: "reservation-id", token: "settle-token", reservedUsd: 0.7 },
  });
  mocks.defaultUsageSinks.mockReturnValue([
    async (r: UsageRunRecord) => {
      emitted.push(r);
    },
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function run(): Promise<{ status: number; body: string; record: UsageRunRecord | undefined }> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const body = await res.text();
  return { status: res.status, body, record: emitted[0] };
}

describe("gate", () => {
  it("rejects zero topics with 400 even with sources, and claims/reserves nothing", async () => {
    setProfile([PICKED], []);
    const { status } = await run();
    expect(status).toBe(400);
    expect(mocks.claimGenerationForUser).not.toHaveBeenCalled();
    expect(mocks.reserveSpend).not.toHaveBeenCalled();
  });

  it("runs zero topics + zero sources as 400 too", async () => {
    setProfile([], []);
    expect((await run()).status).toBe(400);
  });

  it("runs a profile with topics and zero sources to completion, reading every topic", async () => {
    setProfile([], TOPICS.slice(0, 2) as Topic[]);
    const { status, record } = await run();
    expect(status).toBe(200);
    expect(record?.outcome).toBe("complete");
    expect(mocks.ingestArticles).toHaveBeenCalledWith(TOPICS.slice(0, 2), [], expect.anything());
  });
});

describe("reservation is sized to the topics actually read", () => {
  it.each([1, MAX_TOPICS_PER_DIGEST - 1, MAX_TOPICS_PER_DIGEST, TOPICS.length])(
    "profile with %i topics",
    async (n) => {
      const topics = TOPICS.slice(0, n) as Topic[];
      setProfile([], topics);
      await run();
      const reserved = mocks.reserveSpend.mock.calls[0][2].topicCount;
      expect(reserved).toBe(Math.min(n, MAX_TOPICS_PER_DIGEST));
      // And the reservation equals the number of topics handed to ingest.
      expect(mocks.ingestArticles.mock.calls[0][0]).toHaveLength(reserved);
      expect(emitted[0].topicsDropped).toBe(n - reserved);
    }
  );

  it("the worst-case feed count the reservation assumes holds for the topics handed to ingest", async () => {
    setProfile([...SOURCES] as Source[], [...TOPICS] as Topic[]);
    await run();
    const [topicsRead, prefs] = mocks.ingestArticles.mock.calls[0];
    expect(planFeeds(topicsRead, prefs).length).toBeLessThanOrEqual(
      mocks.reserveSpend.mock.calls[0][2].topicCount * MAX_FEEDS_PER_TOPIC
    );
  });
});

describe("boost", () => {
  it("never lifts a judged reject at max severity, nor a fail-closed one, into the cards", async () => {
    mocks.clusterArticles.mockResolvedValue([
      cluster("reject5", [PICKED]),
      cluster("failed", [PICKED, PICKED]),
      cluster("ok", [OTHER]),
    ]);
    triageReturns([{ notable: false, severity: MAX_SEVERITY }, FAIL_CLOSED, { notable: true, severity: 1 }]);
    const { record } = await run();
    expect(written()).toEqual([["ok", 1]]);
    expect(record?.clustersBoosted).toBe(0);
  });

  it("counts a notable cluster already at the cap as boosted but keeps it at the cap", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("top", [PICKED])]);
    triageReturns([{ notable: true, severity: MAX_SEVERITY }]);
    const { record } = await run();
    expect(written()).toEqual([["top", MAX_SEVERITY]]);
    expect(record?.clustersBoosted).toBe(1);
  });

  it("does not let the boost leak into the triage outcome objects (FAIL_CLOSED stays frozen and untouched)", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", [PICKED]), cluster("b", [PICKED])]);
    const shared: TriageOutcome = { notable: true, severity: 2 };
    triageReturns([shared, shared]);
    await run();
    expect(shared).toEqual({ notable: true, severity: 2 });
    // Cards are saved with triage's own grade; the boost only decides survival.
    expect(written()).toEqual([
      ["a", 2],
      ["b", 2],
    ]);
  });
});

describe("existing cards with stored sources", () => {
  it("a stored sources list holding a malformed entry does not fail a run whose cards were already written", async () => {
    // getTodaysCardSummaries accepts any array (Array.isArray only), so a
    // jsonb list with a null element reaches the route as-is.
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { id: "old", topic: TOPIC, shortSummary: "old", severity: 3, sources: [null, { source: PICKED }] },
    ]);
    mocks.clusterArticles.mockResolvedValue([cluster("new", [OTHER])]);
    triageReturns([{ notable: true, severity: 3 }]);

    const { record } = await run();

    expect(mocks.writeCard).toHaveBeenCalledTimes(1);
    expect(record?.outcome).toBe("complete");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });
});
