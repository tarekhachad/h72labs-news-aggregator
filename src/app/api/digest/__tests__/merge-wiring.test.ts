import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, type Card, type Cluster, type Source, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import type { TriageVerdict } from "@/lib/triage";

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

describe("digest route: the duplicate check", () => {
  it("writes one card for one event across two topics, citing both outlets, and records the merge", async () => {
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    mocks.clusterArticles.mockResolvedValue([
      cluster("kyiv-geo", "Geopolitics", [OTHER]),
      cluster("kyiv-defense", "Defense & Security", [OTHER_TOO]),
      cluster("match", "Football", [OTHER]),
    ]);
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 4, event: KYIV_A },
      { notable: true, severity: 3, event: KYIV_B },
      { notable: true, severity: 3, event: MATCH },
    ] satisfies TriageVerdict[]);

    const record = await run();

    expect(written()).toEqual([
      ["kyiv-geo", 4, [OTHER, OTHER_TOO]],
      ["match", 3, [OTHER]],
    ]);
    expect(record.clustersMerged).toBe(1);
    expect(record.notableCount).toBe(2);
    const merge = record.stages.find((s) => s.stage === "merge");
    expect(merge).toMatchObject({ calls: 1, callsWithoutUsage: 0, model: "claude-haiku-4-5" });
  });

  it("boosts each copy on its own outlets before the cap, and writes the merged card with triage's grade", async () => {
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    mocks.clusterArticles.mockResolvedValue([
      cluster("kyiv-geo", "Geopolitics", [OTHER]),
      cluster("kyiv-defense", "Defense & Security", [PICKED]),
    ]);
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 3, event: KYIV_A },
      { notable: true, severity: 2, event: KYIV_B },
    ] satisfies TriageVerdict[]);

    const record = await run();

    expect(written()).toEqual([["kyiv-geo", 3, [OTHER, PICKED]]]);
    expect(record.clustersBoosted).toBe(1);
    expect(record.clustersMerged).toBe(1);
  });

  it("writes both cards when Haiku says they are different events", async () => {
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    haikuSaysSame(false);
    mocks.clusterArticles.mockResolvedValue([
      cluster("kyiv-geo", "Geopolitics", [OTHER]),
      cluster("kyiv-defense", "Defense & Security", [OTHER_TOO]),
    ]);
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 4, event: KYIV_A },
      { notable: true, severity: 3, event: KYIV_B },
    ] satisfies TriageVerdict[]);

    const record = await run();

    expect(written().map(([title]) => title)).toEqual(["kyiv-geo", "kyiv-defense"]);
    expect(record.clustersMerged).toBe(0);
    expect(mocks.parse).toHaveBeenCalledTimes(1);
  });

  it("makes no merge call and records 0 when triage gave no sentences, writing exactly as before", async () => {
    mocks.clusterArticles.mockResolvedValue([
      cluster("a", "Geopolitics", [OTHER]),
      cluster("b", "Football", [OTHER]),
    ]);
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 4 },
      { notable: true, severity: 3 },
    ]);

    const record = await run();

    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(written()).toEqual([
      ["a", 4, [OTHER]],
      ["b", 3, [OTHER]],
    ]);
    expect(record.clustersMerged).toBe(0);
    expect(record.stages.some((s) => s.stage === "merge")).toBe(false);
  });

  it("writes every card and finishes the run when the merge call fails, settling with the call bounded", async () => {
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    mocks.parse.mockRejectedValue(new Error("timed out"));
    mocks.clusterArticles.mockResolvedValue([
      cluster("kyiv-geo", "Geopolitics", [OTHER]),
      cluster("kyiv-defense", "Defense & Security", [OTHER_TOO]),
    ]);
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 4, event: KYIV_A },
      { notable: true, severity: 3, event: KYIV_B },
    ] satisfies TriageVerdict[]);

    const record = await run();

    expect(written()).toHaveLength(2);
    expect(record.outcome).toBe("complete");
    expect(record.clustersMerged).toBe(0);
    expect(record.stages.find((s) => s.stage === "merge")).toMatchObject({ calls: 0, callsWithoutUsage: 1 });
  });

  it("on a top-up, caps every copy exactly as without the check, so a copy the cap cut never takes its surviving duplicate down with it", async () => {
    // A top-up keeps 2 per topic. Geopolitics has two 4s plus the Kyiv story
    // (3 articles); Defense & Security has the same story with 1 article. The
    // cap cuts the Geopolitics copy and keeps the Defense one, as it always
    // did; with only one copy left, nothing is merged and the story is written
    // once, under Defense.
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { id: "existing", topic: "Science", shortSummary: "old", severity: 3, sources: [] },
    ]);
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    mocks.clusterArticles.mockResolvedValue([
      cluster("big-1", "Geopolitics", [OTHER]),
      cluster("big-2", "Geopolitics", [OTHER]),
      cluster("kyiv-geo", "Geopolitics", [OTHER, OTHER_TOO, OTHER]),
      cluster("kyiv-defense", "Defense & Security", [OTHER_TOO]),
    ]);
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 4 },
      { notable: true, severity: 4 },
      { notable: true, severity: 3, event: KYIV_A },
      { notable: true, severity: 3, event: KYIV_B },
    ] satisfies TriageVerdict[]);

    const record = await run();

    expect(written().map(([title]) => title)).toEqual(["big-1", "big-2", "kyiv-defense"]);
    expect(record.cardsDroppedByCap).toBe(1);
    expect(record.clustersMerged).toBe(0);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("writes exactly what a run without merges writes, minus the absorbed duplicates", async () => {
    // A top-up with every unit over its allowance of 2, so the cap binds
    // everywhere; Kyiv survives in both units.
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { id: "existing", topic: "Science", shortSummary: "old", severity: 3, sources: [] },
    ]);
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    const setUp = () => {
      mocks.clusterArticles.mockResolvedValue([
        cluster("g-1", "Geopolitics", [OTHER]),
        cluster("kyiv-geo", "Geopolitics", [OTHER, OTHER_TOO]),
        cluster("g-2", "Geopolitics", [OTHER]),
        cluster("d-1", "Defense & Security", [OTHER]),
        cluster("kyiv-defense", "Defense & Security", [PICKED]),
        cluster("d-2", "Defense & Security", [OTHER]),
      ]);
      mocks.triageClusters.mockResolvedValue([
        { notable: true, severity: 4 },
        { notable: true, severity: 4, event: KYIV_A },
        { notable: true, severity: 2 },
        { notable: true, severity: 4 },
        { notable: true, severity: 3, event: KYIV_B },
        { notable: true, severity: 2 },
      ] satisfies TriageVerdict[]);
    };

    setUp();
    haikuSaysSame(false);
    const unmerged = await run();
    const withoutMerge = written().map(([title]) => title);

    vi.clearAllMocks();
    emitted = [];
    mocks.defaultUsageSinks.mockReturnValue([async (r: UsageRunRecord) => void emitted.push(r)]);
    setUp();
    haikuSaysSame(true);
    const merged = await run();
    const withMerge = written().map(([title]) => title);

    expect(withoutMerge).toEqual(["g-1", "kyiv-geo", "d-1", "kyiv-defense"]);
    expect(withMerge).toEqual(withoutMerge.filter((t) => t !== "kyiv-defense"));
    expect(merged.cardsDroppedByCap).toBe(unmerged.cardsDroppedByCap);
    expect(merged.clustersMerged).toBe(1);
    const kyiv = (mocks.writeCard.mock.calls as [Cluster, number][]).find(([c]) => c.articles[0].title === "kyiv-geo")!;
    expect(kyiv[0].articles.map((a) => a.source)).toEqual([OTHER, OTHER_TOO, PICKED]);
    // Written at triage's own grade, the highest in the group.
    expect(kyiv[1]).toBe(4);
  });

  it("asks Haiku only about stories the cap kept", async () => {
    const MATCH_B = "Arsenal defeated Chelsea 2-1 in the Premier League.";
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { id: "existing", topic: "Science", shortSummary: "old", severity: 3, sources: [] },
    ]);
    mocks.scores.set(`${KYIV_A}|${KYIV_B}`, 0.79);
    mocks.scores.set(`${MATCH}|${MATCH_B}`, 0.85);
    mocks.clusterArticles.mockResolvedValue([
      cluster("big-1", "Geopolitics", [OTHER]),
      cluster("big-2", "Geopolitics", [OTHER]),
      cluster("kyiv-geo", "Geopolitics", [OTHER]),
      cluster("kyiv-defense", "Defense & Security", [OTHER_TOO]),
      cluster("match-a", "Football", [OTHER]),
      cluster("match-b", "Football", [OTHER_TOO]),
    ]);
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 4 },
      { notable: true, severity: 4 },
      { notable: true, severity: 3, event: KYIV_A },
      { notable: true, severity: 3, event: KYIV_B },
      { notable: true, severity: 3, event: MATCH },
      { notable: true, severity: 3, event: MATCH_B },
    ] satisfies TriageVerdict[]);

    const record = await run();

    const content = mocks.parse.mock.calls[0][0].messages[0].content as string;
    expect(content).toContain(MATCH);
    expect(content).not.toContain(KYIV_A);
    expect(written().map(([title]) => title)).toEqual(["big-1", "big-2", "kyiv-defense", "match-a"]);
    expect(record.clustersMerged).toBe(1);
  });

  it("leaves clustersMerged null on a run that ended before the merge", async () => {
    mocks.clusterArticles.mockRejectedValue(new Error("clustering died"));

    const record = await run();

    expect(record.outcome).toBe("endedEarly");
    expect(record.clustersMerged).toBeNull();
  });
});
