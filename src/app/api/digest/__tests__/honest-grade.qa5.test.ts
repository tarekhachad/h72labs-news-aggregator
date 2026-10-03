import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, TOPICS, type Card, type Cluster, type Source, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import type { TriageOutcome } from "@/lib/triageOutcome";
import { TOP_UP_CARDS_PER_TOPIC } from "@/lib/cardCap";

// QA round 5: the boost decides only which stories survive the card cap.
// Every surface after the cap (writeCard, the done event, the persisted
// cards, the ranker's pool, the run record) must carry triage's own grade.
// Drives the REAL POST handler with network, Claude and database mocked.
// Never names a topic or an outlet.

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

const TOPIC = TOPICS[0] as Topic;
const OTHER_TOPIC = TOPICS[1] as Topic;
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
const setProfile = (preferredSources: Source[], topics: Topic[] = [TOPIC, OTHER_TOPIC]) =>
  mocks.getUserProfile.mockResolvedValue({ topics, preferredSources, timeZone: "UTC" });
const triageReturns = (o: TriageOutcome[]) => mocks.triageClusters.mockResolvedValue(o);
const written = () =>
  (mocks.writeCard.mock.calls as [Cluster, number][]).map(([c, s]) => [c.articles[0].title, s]);
const severityByTitle = (cards: { title: string; severity: number }[]) =>
  Object.fromEntries(cards.map((c) => [c.title, c.severity]));

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  setProfile([PICKED]);
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue([]);
  triageReturns([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-01T10:00:00Z");
  mocks.rankFrontPage.mockImplementation(async (pool: unknown[]) => pool.map((_, i) => (i < 6 ? i + 1 : null)));
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

type Event = { stage: string; notableCount?: number; cards?: Card[] };
async function run(): Promise<{ events: Event[]; record: UsageRunRecord }> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const body = await res.text();
  const events = body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Event);
  return { events, record: emitted[0] };
}

// A later same-day run: two cards already saved for TOPIC, so the top-up
// allowance applies. Three new TOPIC stories compete for it:
//   picked3 — triage 3, carried by a picked outlet (boosted to 4)
//   plain4  — triage 4, no picked outlet
//   plain3  — triage 3, no picked outlet, better corroborated than picked3
// With the pick, picked3 ties plain4 at 4 and wins on the boost, so plain3
// is cut. Without any pick, plain3 beats picked3 on corroboration.
const EXISTING = [
  { id: "e-picked", topic: TOPIC, shortSummary: "earlier picked", severity: 4, sources: [{ source: PICKED }] },
  { id: "e-plain", topic: TOPIC, shortSummary: "earlier plain", severity: 2, sources: [{ source: OTHER }] },
];
function laterSameDayRun() {
  mocks.getTodaysCardSummaries.mockResolvedValue(EXISTING);
  mocks.clusterArticles.mockResolvedValue([
    cluster("picked3", [PICKED]),
    cluster("plain4", [OTHER]),
    cluster("plain3", [OTHER, OTHER]),
  ]);
  triageReturns([
    { notable: true, severity: 3 },
    { notable: true, severity: 4 },
    { notable: true, severity: 3 },
  ]);
}

describe("later same-day run with a picked outlet", () => {
  it("the boost wins picked3 its top-up slot", async () => {
    expect(TOP_UP_CARDS_PER_TOPIC).toBe(2); // the scenario is sized for this allowance
    laterSameDayRun();
    const { record } = await run();
    expect(written()).toEqual([
      ["picked3", 3],
      ["plain4", 4],
    ]);
    expect(record.runShape).toBe("sameDayTopUp");
    expect(record.clustersBoosted).toBe(1);
    expect(record.cardsDroppedByCap).toBe(1);
    expect(record.notableCount).toBe(2);
  });

  it("the writing event counts the kept cards, and the done event carries triage's grade on each", async () => {
    laterSameDayRun();
    const { events } = await run();
    expect(events.find((e) => e.stage === "writing")?.notableCount).toBe(2);
    const done = events.find((e) => e.stage === "done");
    expect(severityByTitle(done?.cards ?? [])).toEqual({ picked3: 3, plain4: 4 });
  });

  it("persists triage's grade on the new cards", async () => {
    laterSameDayRun();
    await run();
    const saved = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(severityByTitle(saved)).toEqual({ picked3: 3, plain4: 4 });
  });

  it("the ranker reads stored severities for earlier cards, triage's for new ones, and picks only as a count", async () => {
    laterSameDayRun();
    await run();
    const pool = mocks.rankFrontPage.mock.calls[0][0] as {
      text: string;
      severity: number;
      preferredSourceCount: number;
    }[];
    // New cards reach the pool in the route's publishedAt/id order, so compare by text.
    expect(Object.fromEntries(pool.map((c) => [c.text, [c.severity, c.preferredSourceCount]]))).toEqual({
      "earlier picked": [4, 1],
      "earlier plain": [2, 0],
      "summary picked3": [3, 1],
      "summary plain4": [4, 0],
    });
    // Earlier cards lead the pool, so their rank results map back to their rows.
    expect(pool.slice(0, 2).map((c) => c.text)).toEqual(["earlier picked", "earlier plain"]);
  });
});

describe("the boost is what decides survival", () => {
  it("a boosted triage 3 takes the last top-up slot from an unboosted triage 4, and its card still says 3", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue(EXISTING);
    mocks.clusterArticles.mockResolvedValue([
      cluster("plain4a", [OTHER]),
      cluster("plain4b", [OTHER]),
      cluster("picked3", [PICKED]),
    ]);
    triageReturns([
      { notable: true, severity: 4 },
      { notable: true, severity: 4 },
      { notable: true, severity: 3 },
    ]);
    const { record } = await run();
    expect(written()).toEqual([
      ["plain4a", 4],
      ["picked3", 3],
    ]);
    expect(record.cardsDroppedByCap).toBe(1);
    const saved = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(severityByTitle(saved)).toEqual({ plain4a: 4, picked3: 3 });
  });
});

describe("same later run with zero picks", () => {
  it("keeps the better-corroborated plain3 instead, with every grade and count unchanged", async () => {
    setProfile([]);
    laterSameDayRun();
    const { record } = await run();
    expect(written()).toEqual([
      ["plain4", 4],
      ["plain3", 3],
    ]);
    expect(record.clustersBoosted).toBe(0);
    const pool = mocks.rankFrontPage.mock.calls[0][0] as {
      text: string;
      severity: number;
      preferredSourceCount: number;
    }[];
    expect(Object.fromEntries(pool.map((c) => [c.text, [c.severity, c.preferredSourceCount]]))).toEqual({
      "earlier picked": [4, 0],
      "earlier plain": [2, 0],
      "summary plain4": [4, 0],
      "summary plain3": [3, 0],
    });
  });
});

describe("boost across topics", () => {
  it("a boosted story in one topic never displaces a story in another, and both keep triage's grade", async () => {
    // First run of the day: each topic has the first-run allowance, so nothing is cut.
    mocks.clusterArticles.mockResolvedValue([
      cluster("a-picked", [PICKED], TOPIC),
      cluster("b-plain", [OTHER], OTHER_TOPIC),
    ]);
    triageReturns([
      { notable: true, severity: 2 },
      { notable: true, severity: 5 },
    ]);
    const { record } = await run();
    expect(written()).toEqual([
      ["a-picked", 2],
      ["b-plain", 5],
    ]);
    expect(record.cardsDroppedByCap).toBe(0);
  });

  it("a failed existing-cards lookup still writes triage's grade (cap at the top-up allowance, no ranking)", async () => {
    mocks.getTodaysCardSummaries.mockRejectedValue(new Error("db down"));
    mocks.clusterArticles.mockResolvedValue([
      cluster("picked2", [PICKED]),
      cluster("plain3", [OTHER]),
      cluster("plain2", [OTHER]),
    ]);
    triageReturns([
      { notable: true, severity: 2 },
      { notable: true, severity: 3 },
      { notable: true, severity: 2 },
    ]);
    const { record } = await run();
    // picked2 boosted to 3 ties plain3 and wins on the boost; plain2 is cut.
    expect(written()).toEqual([
      ["picked2", 2],
      ["plain3", 3],
    ]);
    expect(record.runShape).toBe("unknown");
    expect(mocks.rankFrontPage).not.toHaveBeenCalled();
    const saved = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(severityByTitle(saved)).toEqual({ picked2: 2, plain3: 3 });
  });
});
