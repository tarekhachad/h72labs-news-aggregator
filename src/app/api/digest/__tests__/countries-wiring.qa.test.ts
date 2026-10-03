import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TOPICS, type Card, type Cluster, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import type { TriageOutcome } from "@/lib/triageOutcome";
import { FIRST_RUN_CARDS_PER_TOPIC } from "@/lib/cardCap";
import { topicsToRead } from "@/lib/ingest";

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


// QA round 1: zero-countries invariant and edge profiles, against the real
// POST handler with the same mocks as countries-wiring.test.ts.
describe("QA: digest route reading units", () => {
  const cases: [string, Topic[]][] = [
    ["3 plain topics", PLAIN.slice(0, 3)],
    ["10 plain topics", PLAIN.slice(0, 10)],
    ["12 plain topics given out of curated order", [...PLAIN.slice(0, 12)].reverse()],
    ["duplicated plain topics", [PLAIN[2], PLAIN[0], PLAIN[2], PLAIN[1]]],
  ];

  it.each(cases)("zero countries (%s): ingest, reservation and topicsDropped match the old topicsToRead", async (_n, topics) => {
    setProfile(topics, []);
    const { status, record } = await run();
    expect(status).toBe(200);
    const old = topicsToRead(topics);
    expect(mocks.ingestUnits).toHaveBeenCalledTimes(1);
    expect(mocks.ingestUnits.mock.calls[0][0]).toEqual(old.read.map((topic) => ({ topic, subtopic: null })));
    expect(mocks.reserveSpend.mock.calls[0][2].topicCount).toBe(old.read.length);
    expect(record?.topicsDropped).toBe(old.dropped.length);
    expect(record?.topicCount).toBe(new Set(topics).size);
  });

  it("stray countries on a profile without the Countries topic change nothing", async () => {
    setProfile(PLAIN.slice(0, 4), ["Uganda", "Kenya"]);
    await run();
    expect(mocks.ingestUnits.mock.calls[0][0]).toEqual(PLAIN.slice(0, 4).map((topic) => ({ topic, subtopic: null })));
    expect(mocks.reserveSpend.mock.calls[0][2].topicCount).toBe(4);
    expect(emitted[0]?.topicCount).toBe(4);
  });

  it("Countries saved with zero countries: the container is never read as a unit", async () => {
    setProfile([PLAIN[0], PLAIN[1], COUNTRIES_TOPIC], []);
    const { record } = await run();
    expect(mocks.ingestUnits.mock.calls[0][0]).toEqual([
      { topic: PLAIN[0], subtopic: null },
      { topic: PLAIN[1], subtopic: null },
    ]);
    expect(mocks.reserveSpend.mock.calls[0][2].topicCount).toBe(2);
    expect(record?.topicCount).toBe(2);
  });

  it("Countries-only profile with zero countries still answers 200 and reserves topicCount 0 (DB floors it at 1)", async () => {
    setProfile([COUNTRIES_TOPIC], []);
    const { status } = await run();
    expect(status).toBe(200);
    expect(mocks.ingestUnits.mock.calls[0][0]).toEqual([]);
    expect(mocks.reserveSpend.mock.calls[0][2].topicCount).toBe(0);
  });

  it("reservation topicCount always equals the number of units handed to ingest", async () => {
    setProfile([...PLAIN.slice(0, 9), COUNTRIES_TOPIC], ["Ghana", "Uganda", "Kenya"]);
    await run();
    expect(mocks.reserveSpend.mock.calls[0][2].topicCount).toBe(mocks.ingestUnits.mock.calls[0][0].length);
    expect(mocks.ingestUnits.mock.calls[0][0]).toHaveLength(10);
  });

  it("warns with the read/skip counts when units are dropped", async () => {
    setProfile([...PLAIN.slice(0, 8), COUNTRIES_TOPIC], ["Ghana", "Morocco", "Kenya", "Uganda"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      "[digest] profile has 12 topics and countries; reading 10, skipping 2"
    );
  });

  it("a plain topic and a country both get the full first-run allowance in one run", async () => {
    const clusters = [...clustersOf("p", PLAIN[0], null, 9), ...clustersOf("u", COUNTRIES_TOPIC, "Uganda", 9)];
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue(allNotable(clusters.length));
    await run();
    const written = mocks.writeCard.mock.calls as [Cluster, number][];
    expect(written.filter(([c]) => c.subtopic === null)).toHaveLength(FIRST_RUN_CARDS_PER_TOPIC);
    expect(written.filter(([c]) => c.subtopic === "Uganda")).toHaveLength(FIRST_RUN_CARDS_PER_TOPIC);
  });

  it("an ingest failure still releases the generation claim", async () => {
    mocks.ingestUnits.mockRejectedValue(new Error("ingestUnits is built in V2.5 L10"));
    await run();
    expect(mocks.releaseGenerationClaim).toHaveBeenCalled();
  });
});
