import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, TOPICS, type Card, type Cluster, type Source, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { FAIL_CLOSED, type TriageOutcome } from "@/lib/triageOutcome";
import { MAX_TOPICS_PER_DIGEST } from "@/lib/ingest";
import { TOP_UP_CARDS_PER_TOPIC } from "@/lib/cardCap";

// Drives the REAL route POST handler with a profile that has picked outlets,
// and checks each place the pick is meant to count: the triage boost, the
// card cap, the writer, the ranker's candidates, the topic bound, and the
// run record.

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
const [PICKED, PICKED_TOO, OTHER, OTHER_TOO] = SOURCES.slice(0, 4) as Source[];

function cluster(label: string, sources: Source[]): Cluster {
  return {
    topic: TOPIC,
    articles: sources.map((source, i) => ({
      title: i === 0 ? label : `${label} (${i})`,
      snippet: "",
      url: `https://example.com/${label}/${i}`,
      source,
      topic: TOPIC,
      publishedAt: "2026-10-02T12:00:00Z",
    })),
  };
}

/** A card echoing the cluster it was written from, as the real writer does. */
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
    generatedAt: "overwritten-by-route",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

let emitted: UsageRunRecord[];

function setProfile(preferredSources: Source[], topics: Topic[] = [TOPIC]) {
  mocks.getUserProfile.mockResolvedValue({ topics, preferredSources, timeZone: "UTC" });
}

function triageReturns(outcomes: TriageOutcome[]) {
  mocks.triageClusters.mockResolvedValue(outcomes);
}

/** [cluster label, severity] for each writeCard call, in call order. */
const written = () =>
  (mocks.writeCard.mock.calls as [Cluster, number][]).map(([c, severity]) => [c.articles[0].title, severity]);

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  setProfile([PICKED, PICKED_TOO]);
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-01T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => cardFor(c, severity));
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(): Promise<UsageRunRecord> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
  expect(emitted).toHaveLength(1);
  return emitted[0];
}

describe("digest route: preferred sources", () => {
  it("counts the boosted clusters but writes every card with triage's own grade", async () => {
    mocks.clusterArticles.mockResolvedValue([
      cluster("picked", [OTHER, PICKED]),
      cluster("plain", [OTHER]),
      cluster("top", [PICKED_TOO]),
    ]);
    triageReturns([
      { notable: true, severity: 2 },
      { notable: true, severity: 2 },
      { notable: true, severity: 5 },
    ]);

    const record = await run();

    expect(written()).toEqual([
      ["picked", 2],
      ["plain", 2],
      ["top", 5],
    ]);
    expect(record.clustersBoosted).toBe(2);
  });

  it("never boosts a fail-closed cluster or a judged reject into the digest", async () => {
    mocks.clusterArticles.mockResolvedValue([
      cluster("failed", [PICKED]),
      cluster("rejected", [PICKED]),
      cluster("kept", [OTHER]),
    ]);
    triageReturns([FAIL_CLOSED, { notable: false, severity: 1 }, { notable: true, severity: 4 }]);

    const record = await run();

    expect(written()).toEqual([["kept", 4]]);
    expect(record.clustersBoosted).toBe(0);
    expect(record.triageFailedClosed).toBe(1);
  });

  it("lets a boosted story win a top-up slot it would otherwise lose", async () => {
    expect(TOP_UP_CARDS_PER_TOPIC).toBe(2);
    // A top-up (cards already exist today) keeps 2 per topic.
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { id: "existing", topic: TOPIC, shortSummary: "old", severity: 3, sources: [] },
    ]);
    mocks.clusterArticles.mockResolvedValue([
      cluster("plain-a", [OTHER, OTHER_TOO]),
      cluster("plain-b", [OTHER]),
      cluster("picked", [PICKED]),
    ]);
    triageReturns([
      { notable: true, severity: 3 },
      { notable: true, severity: 3 },
      { notable: true, severity: 2 },
    ]);

    const record = await run();

    // The boost wins "picked" its slot, but its card keeps triage's 2.
    expect(written()).toEqual([
      ["plain-a", 3],
      ["picked", 2],
    ]);
    expect(record.cardsDroppedByCap).toBe(1);
  });

  it("ranks a boosted card on triage's grade, with the pick reaching the ranker only as a count", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("picked", [PICKED]), cluster("plain", [OTHER])]);
    triageReturns([
      { notable: true, severity: 4 },
      { notable: true, severity: 4 },
    ]);

    await run();

    const pool = mocks.rankFrontPage.mock.calls[0][0] as { text: string; severity: number; preferredSourceCount: number }[];
    const byText = Object.fromEntries(pool.map((c) => [c.text, [c.severity, c.preferredSourceCount]]));
    expect(byText).toEqual({ "summary picked": [4, 1], "summary plain": [4, 0] });
    const saved = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(saved.find((c) => c.title === "picked")?.severity).toBe(4);
  });

  it("writes a boosted card that hit the cap with triage's grade, keeping the two boosted stories in triage's order", async () => {
    // Top-up: 2 slots. Triage 5 and two triage 4s, all with picked outlets,
    // all boosted to 5. The triage 5 keeps its slot and its card says 5.
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { id: "existing", topic: TOPIC, shortSummary: "old", severity: 3, sources: [] },
    ]);
    mocks.clusterArticles.mockResolvedValue([
      cluster("four-a", [PICKED, PICKED_TOO]),
      cluster("five", [PICKED]),
      cluster("four-b", [PICKED_TOO, PICKED]),
    ]);
    triageReturns([
      { notable: true, severity: 4 },
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
    ]);

    const record = await run();

    expect(written()).toEqual([
      ["four-a", 4],
      ["five", 5],
    ]);
    expect(record.clustersBoosted).toBe(3);
  });

  it("hands the profile's picked outlets to every writeCard call", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", [OTHER]), cluster("b", [PICKED])]);
    triageReturns([
      { notable: true, severity: 3 },
      { notable: true, severity: 3 },
    ]);

    await run();

    for (const call of mocks.writeCard.mock.calls) expect(call[2]).toEqual([PICKED, PICKED_TOO]);
  });

  it("gives every rank candidate, existing and new, its preferred-source count", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([
      {
        id: "existing",
        topic: TOPIC,
        shortSummary: "old",
        severity: 3,
        sources: [
          { title: "x", url: "https://e.x/1", source: PICKED, snippet: "" },
          { title: "y", url: "https://e.x/2", source: PICKED_TOO, snippet: "" },
          { title: "z", url: "https://e.x/3", source: PICKED, snippet: "" },
        ],
      },
    ]);
    mocks.clusterArticles.mockResolvedValue([cluster("one", [PICKED, OTHER]), cluster("none", [OTHER])]);
    triageReturns([
      { notable: true, severity: 3 },
      { notable: true, severity: 3 },
    ]);

    await run();

    // Existing cards first, then this run's in the route's own card order.
    const pool = mocks.rankFrontPage.mock.calls[0][0] as { text: string; preferredSourceCount: number }[];
    expect(pool[0]).toMatchObject({ text: "old", preferredSourceCount: 2 });
    expect(Object.fromEntries(pool.slice(1).map((c) => [c.text, c.preferredSourceCount]))).toEqual({
      "summary one": 1,
      "summary none": 0,
    });
  });

  it("counts an existing card with no stored sources as zero rather than failing the run", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { id: "legacy", topic: TOPIC, shortSummary: "old", severity: 3 },
    ]);
    mocks.clusterArticles.mockResolvedValue([]);
    triageReturns([]);

    const record = await run();

    expect(record.outcome).toBe("complete");
    expect(mocks.rankFrontPage.mock.calls[0][0][0].preferredSourceCount).toBe(0);
  });

  it("with zero picked outlets changes nothing: no boost, zero counts, and the run still reads its topics", async () => {
    setProfile([]);
    mocks.clusterArticles.mockResolvedValue([cluster("a", [PICKED]), cluster("b", [OTHER])]);
    triageReturns([
      { notable: true, severity: 2 },
      { notable: true, severity: 4 },
    ]);

    const record = await run();

    expect(written()).toEqual([
      ["a", 2],
      ["b", 4],
    ]);
    expect(record.clustersBoosted).toBe(0);
    expect(record.sourceCount).toBe(0);
    expect(mocks.ingestArticles).toHaveBeenCalledWith([TOPIC], [], expect.anything());
    expect(mocks.rankFrontPage.mock.calls[0][0].map((c: { preferredSourceCount: number }) => c.preferredSourceCount)).toEqual([0, 0]);
  });

  it("reads at most 10 topics, in curated order, and records how many were skipped", async () => {
    const topics = TOPICS.slice(0, MAX_TOPICS_PER_DIGEST + 3) as Topic[];
    setProfile([], [...topics].reverse());
    mocks.clusterArticles.mockResolvedValue([]);
    triageReturns([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const record = await run();

    expect(mocks.ingestArticles.mock.calls[0][0]).toEqual(topics.slice(0, MAX_TOPICS_PER_DIGEST));
    expect(record.topicsDropped).toBe(3);
    expect(record.topicCount).toBe(MAX_TOPICS_PER_DIGEST + 3);
    expect(warn.mock.calls.some(([line]) => String(line).includes("skipping"))).toBe(true);
  });

  it("records zero topics skipped for a profile within the bound", async () => {
    mocks.clusterArticles.mockResolvedValue([]);
    triageReturns([]);

    const record = await run();

    expect(record.topicsDropped).toBe(0);
  });

  it("records clustersBoosted as null when the run ends before triage", async () => {
    mocks.clusterArticles.mockRejectedValue(new Error("clustering broke"));

    const record = await run();

    expect(record.outcome).toBe("endedEarly");
    expect(record.clustersBoosted).toBeNull();
    expect(record.topicsDropped).toBe(0);
  });
});
