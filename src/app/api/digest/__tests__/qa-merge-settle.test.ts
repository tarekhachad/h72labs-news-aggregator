import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, type Card, type Cluster, type Source, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import type { TriageVerdict } from "@/lib/triage";
import { recordCall } from "@/lib/usageCollector";
import { triageBatchCount } from "@/lib/triage";
import { settleSpend } from "@/lib/spend";

// Drives the REAL route POST handler and the REAL duplicate check, with the
// embedding model and the Anthropic SDK mocked, and checks where the merge
// sits: after triage, before the boost and the card cap, so one card is
// written for one event and the run records the merge.

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
  parse: vi.fn(),
  embed: vi.fn(),
  scores: new Map<string, number>(),
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
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mocks.parse }, maxRetries: 0 };
  }
  return { default: FakeAnthropic };
});
// Each sentence's vector is its own text; the score is read from a table.
vi.mock("@/lib/embeddings", () => ({
  embed: mocks.embed,
  cosineSimilarity: (a: string[], b: string[]) =>
    mocks.scores.get(`${a[0]}|${b[0]}`) ?? mocks.scores.get(`${b[0]}|${a[0]}`) ?? 0.2,
}));

const [PICKED, OTHER, OTHER_TOO] = SOURCES.slice(0, 3) as Source[];

function cluster(label: string, topic: Topic, sources: Source[], subtopic?: string): Cluster {
  return {
    topic,
    ...(subtopic ? { subtopic } : {}),
    articles: sources.map((source, i) => ({
      title: i === 0 ? label : `${label} (${i})`,
      snippet: "",
      url: `https://example.com/${label}/${i}`,
      source,
      topic,
      ...(subtopic ? { subtopic } : {}),
      publishedAt: "2026-10-03T12:00:00Z",
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
    publishedAt: "2026-10-03T12:00:00Z",
    generatedAt: "overwritten-by-route",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

let emitted: UsageRunRecord[];

/** Haiku says "same" to every pair it is sent. */
function haikuSaysSame(same: boolean) {
  mocks.parse.mockImplementation(async (params: { messages: { content: string }[] }) => {
    const count = (params.messages[0].content.match(/^\d+\.$/gm) ?? []).length;
    return {
      parsed_output: { verdicts: Array.from({ length: count }, (_, pair) => ({ pair, same })) },
      stop_reason: "end_turn",
      usage: { input_tokens: 400, output_tokens: 30 },
    };
  });
}

const written = () =>
  (mocks.writeCard.mock.calls as [Cluster, number][]).map(([c, severity]) => [
    c.articles[0].title,
    severity,
    c.articles.map((a) => a.source),
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scores.clear();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Geopolitics", "Defense & Security", "Football"],
    preferredSources: [PICKED],
    countries: [],
    timeZone: "UTC",
  });
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-02T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => cardFor(c, severity));
  mocks.embed.mockImplementation(async (texts: string[]) => texts.map((t) => [t]));
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
  haikuSaysSame(true);
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

const KYIV_A = "Russia launched a large overnight attack on Kyiv.";
const KYIV_B = "A massive Russian strike hit Kyiv overnight.";
const MATCH = "Arsenal beat Chelsea 2-1 at the Emirates.";


// QA round 1: every mocked stage records its call the way the real ones do,
// so the only thing that can make a run a floor is the merge stage's own
// accounting (expectedCalls.merge against what the collector saw).
const billed = { usage: { input_tokens: 1000, output_tokens: 100 } };
function recordingStages(verdicts: TriageVerdict[]) {
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) => {
    for (let i = 0; i < triageBatchCount(cs); i += 1) await recordCall("triage", "claude-haiku-4-5", async () => billed);
    return verdicts;
  });
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => {
    await recordCall("writeCard", "claude-sonnet-5", async () => billed);
    return cardFor(c, severity);
  });
  mocks.rankFrontPage.mockImplementation(async () => {
    await recordCall("rank", "claude-haiku-4-5", async () => billed);
    return null;
  });
}

const settled = () => vi.mocked(settleSpend).mock.calls.at(-1)![1];

describe("QA: the merge stage's expected-call count against the settle", () => {
  it("a run whose sentences have no candidate pair is not a floor and settles at its total", async () => {
    mocks.clusterArticles.mockResolvedValue([
      cluster("a", "Geopolitics", [OTHER]),
      cluster("b", "Football", [OTHER]),
    ]);
    recordingStages([
      { notable: true, severity: 4, event: KYIV_A },
      { notable: true, severity: 3, event: MATCH },
    ]);

    const record = await run();

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(record.isFloor).toBe(false);
    expect(settled()).toBe(record.totalBilledUsd);
  });

  it("a run with no sentences is not a floor", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a", "Geopolitics", [OTHER])]);
    recordingStages([{ notable: true, severity: 4 }]);

    const record = await run();

    expect(record.isFloor).toBe(false);
    expect(record.clustersMerged).toBe(0);
  });

  it("a successful merge call is not a floor and settles at its total", async () => {
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    mocks.clusterArticles.mockResolvedValue([
      cluster("kyiv-geo", "Geopolitics", [OTHER]),
      cluster("kyiv-defense", "Defense & Security", [OTHER_TOO]),
    ]);
    recordingStages([
      { notable: true, severity: 4, event: KYIV_A },
      { notable: true, severity: 3, event: KYIV_B },
    ]);

    const record = await run();

    expect(record.isFloor).toBe(false);
    expect(record.clustersMerged).toBe(1);
    expect(mocks.writeCard).toHaveBeenCalledTimes(1);
    expect(settled()).toBe(record.totalBilledUsd);
  });

  it("a failed merge call settles below the full reservation, bounded by the call's ceiling", async () => {
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    mocks.parse.mockRejectedValue(new Error("timed out"));
    mocks.clusterArticles.mockResolvedValue([
      cluster("kyiv-geo", "Geopolitics", [OTHER]),
      cluster("kyiv-defense", "Defense & Security", [OTHER_TOO]),
    ]);
    recordingStages([
      { notable: true, severity: 4, event: KYIV_A },
      { notable: true, severity: 3, event: KYIV_B },
    ]);

    const record = await run();

    expect(record.isFloor).toBe(true);
    const amount = settled();
    expect(amount).not.toBeNull();
    expect(amount!).toBeGreaterThan(record.totalBilledUsd);
    expect(amount!).toBeLessThan(0.7);
  });

  it("the cap runs before the merge, exactly as without it: 9 notable in one topic keep 8, then a duplicate pair among them becomes one card", async () => {
    const DUP_A = "Real Madrid beat Barcelona 2-1 at the Bernabeu.";
    const DUP_B = "Real Madrid defeated Barcelona 2-1 in El Clasico.";
    mocks.scores.set(`${DUP_A}|${DUP_B}`, 0.9);
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
    const clusters = Array.from({ length: 9 }, (_, i) => cluster(`fb${i}`, "Football", [OTHER]));
    mocks.clusterArticles.mockResolvedValue(clusters);
    recordingStages(
      clusters.map((_, i) => ({
        notable: true,
        severity: i === 8 ? 1 : 3,
        event: i === 0 ? DUP_A : i === 1 ? DUP_B : `Football event ${i}.`,
      }))
    );

    const record = await run();

    expect(record.cardsDroppedByCap).toBe(1);
    expect(record.clustersMerged).toBe(1);
    // The slot the merge frees is not refilled: fb8 was cut by the cap, as it
    // would have been without the check.
    expect(written().map(([t]) => t)).not.toContain("fb8");
    expect(written()).toHaveLength(7);
    expect(record.notableCount).toBe(7);
  });
});
