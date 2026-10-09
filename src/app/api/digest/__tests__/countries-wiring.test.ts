import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TOPICS, type Card, type Cluster, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import type { TriageOutcome } from "@/lib/triageOutcome";
import { DAILY_CARDS_PER_TOPIC_CEILING, FIRST_RUN_CARDS_PER_TOPIC, TOP_UP_CARDS_PER_TOPIC } from "@/lib/cardCap";

// The digest route for a reader with picked countries: each country is its
// own reading unit, so it is handed to ingest as one, counted in the spend
// reservation, and capped on its own. Drives the REAL POST handler, with the
// real card cap and reading-unit expansion; everything that would touch the
// network, Claude or the database is mocked.

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
  reserveSpend: vi.fn(),
}));

// COUNTRIES is empty until the country catalog lands.
vi.mock("@/config/countries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/countries")>()),
  COUNTRIES: ["Uganda", "Kenya", "Morocco", "Ghana"],
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

const COUNTRIES_TOPIC = "Countries" as Topic;
const PLAIN = TOPICS.filter((t) => t !== "Countries") as Topic[];

function cluster(label: string, topic: Topic, subtopic: string | null = null): Cluster {
  return {
    topic,
    subtopic,
    articles: [
      {
        title: label,
        snippet: "",
        url: `https://example.com/${label}`,
        source: "BBC",
        topic,
        subtopic,
        publishedAt: "2026-10-03T12:00:00Z",
      },
    ],
  };
}

function cardFor(c: Cluster, severity: number): Card {
  return {
    id: `card-${c.articles[0].title}`,
    topic: c.topic,
    subtopic: c.subtopic ?? null,
    title: c.articles[0].title,
    shortSummary: `summary ${c.articles[0].title}`,
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-03T12:00:00Z",
    generatedAt: "x",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

let emitted: UsageRunRecord[];
const setProfile = (topics: Topic[], countries: string[]) =>
  mocks.getUserProfile.mockResolvedValue({ topics, preferredSources: [], countries, timeZone: "UTC" });
const clustersOf = (prefix: string, topic: Topic, subtopic: string | null, n: number) =>
  Array.from({ length: n }, (_, i) => cluster(`${prefix}${i}`, topic, subtopic));
const allNotable = (n: number): TriageOutcome[] => Array.from({ length: n }, () => ({ notable: true, severity: 3 }));
const writtenFor = (subtopic: string) =>
  (mocks.writeCard.mock.calls as [Cluster, number][]).filter(([c]) => c.subtopic === subtopic).length;

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  setProfile([PLAIN[0], COUNTRIES_TOPIC], ["Kenya", "Uganda"]);
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue([]);
  mocks.triageClusters.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-02T10:00:00Z");
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

async function run(): Promise<{ status: number; record: UsageRunRecord | undefined }> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
  return { status: res.status, record: emitted[0] };
}

describe("digest route: picked countries as reading units", () => {
  it("hands ingest each country as its own unit, in curated order, and reserves for every unit", async () => {
    const { status, record } = await run();

    expect(status).toBe(200);
    expect(mocks.ingestUnits).toHaveBeenCalledWith(
      [
        { topic: PLAIN[0], subtopic: null },
        { topic: COUNTRIES_TOPIC, subtopic: "Uganda" },
        { topic: COUNTRIES_TOPIC, subtopic: "Kenya" },
      ],
      [],
      "2026-10-02T10:00:00Z", undefined
    );
    expect(mocks.reserveSpend.mock.calls[0][2].topicCount).toBe(3);
    expect(record?.topicCount).toBe(3);
    expect(record?.topicsDropped).toBe(0);
  });

  it("reads at most 10 units, skipping the countries past the bound, and reserves for 10", async () => {
    // Every plain topic here sorts before Countries, so the last countries
    // in COUNTRIES order are the ones past the bound.
    setProfile([...PLAIN.slice(0, 8), COUNTRIES_TOPIC], ["Ghana", "Morocco", "Kenya", "Uganda"]);

    const { record } = await run();

    const read = mocks.ingestUnits.mock.calls[0][0] as { topic: Topic; subtopic: string | null }[];
    expect(read).toHaveLength(10);
    expect(read.slice(8)).toEqual([
      { topic: COUNTRIES_TOPIC, subtopic: "Uganda" },
      { topic: COUNTRIES_TOPIC, subtopic: "Kenya" },
    ]);
    expect(mocks.reserveSpend.mock.calls[0][2].topicCount).toBe(10);
    expect(record?.topicCount).toBe(12);
    expect(record?.topicsDropped).toBe(2);
  });

  it("gives each country the full first-run card allowance, and names the country in the cut log", async () => {
    const clusters = [...clustersOf("u", COUNTRIES_TOPIC, "Uganda", 10), ...clustersOf("k", COUNTRIES_TOPIC, "Kenya", 10)];
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue(allNotable(clusters.length));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { record } = await run();

    expect(writtenFor("Uganda")).toBe(FIRST_RUN_CARDS_PER_TOPIC);
    expect(writtenFor("Kenya")).toBe(FIRST_RUN_CARDS_PER_TOPIC);
    expect(record?.cardsDroppedByCap).toBe(4);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(`[digest] Countries: Uganda: kept ${FIRST_RUN_CARDS_PER_TOPIC} of 10 notable — dropped 2 at severity 3, 3`);
    expect(lines).toContain(`[digest] Countries: Kenya: kept ${FIRST_RUN_CARDS_PER_TOPIC} of 10 notable — dropped 2 at severity 3, 3`);
  });

  it("caps a top-up per country against that country's existing cards, which dedup also sees by country", async () => {
    const existing = Array.from({ length: DAILY_CARDS_PER_TOPIC_CEILING }, (_, i) => ({
      id: `e${i}`,
      topic: COUNTRIES_TOPIC,
      subtopic: "Uganda",
      shortSummary: `existing ${i}`,
      severity: 3,
      sources: [],
    }));
    mocks.getTodaysCardSummaries.mockResolvedValue(existing);
    const clusters = [...clustersOf("u", COUNTRIES_TOPIC, "Uganda", 3), ...clustersOf("k", COUNTRIES_TOPIC, "Kenya", 3)];
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue(allNotable(clusters.length));

    await run();

    expect(writtenFor("Uganda")).toBe(0);
    expect(writtenFor("Kenya")).toBe(TOP_UP_CARDS_PER_TOPIC);
    expect(mocks.filterAlreadyCovered).toHaveBeenCalledWith(clusters, existing);
  });

  it("passes the written cards' country through to the save", async () => {
    const clusters = [cluster("u0", COUNTRIES_TOPIC, "Uganda"), cluster("t0", PLAIN[0])];
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue(allNotable(2));

    await run();

    const saved = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(saved.map((c) => [c.topic, c.subtopic])).toEqual(
      expect.arrayContaining([
        [COUNTRIES_TOPIC, "Uganda"],
        [PLAIN[0], null],
      ])
    );
  });
});
