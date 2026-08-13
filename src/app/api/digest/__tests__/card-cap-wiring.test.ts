import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MAX_CARDS_PER_TOPIC } from "@/lib/cardCap";
import type { Card, Cluster, Topic } from "@/types";

// Drives the REAL route POST handler through the NDJSON stream, same
// pattern as rank-wiring.test.ts. What's under test is where the per-topic
// cap sits in the pipeline, which the unit tests in cardCap.test.ts can't
// see: it has to be applied BEFORE the `writing` event is yielded (the
// client renders "Writing N cards…" straight off notableCount) and before
// expectedCalls.writeCard is set (the cost summary compares calls made
// against that same number). Capping after either would make one of them
// lie about a run that already happened.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestArticles: vi.fn(),
  clusterArticles: vi.fn(),
  filterAlreadyCovered: vi.fn(),
  triageCluster: vi.fn(),
  writeCard: vi.fn(),
  rankFrontPage: vi.fn(),
  upsertDigestForToday: vi.fn(),
  getLatestGeneratedAtForUser: vi.fn(),
  saveGeneratedCards: vi.fn(),
  claimDigestForGeneration: vi.fn(),
  releaseDigestGeneration: vi.fn(),
  getTodaysCardSummaries: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/ingest", () => ({ ingestArticles: mocks.ingestArticles }));
vi.mock("@/lib/cluster", () => ({ clusterArticles: mocks.clusterArticles }));
vi.mock("@/lib/dedup", () => ({ filterAlreadyCovered: mocks.filterAlreadyCovered }));
vi.mock("@/lib/triage", () => ({ triageCluster: mocks.triageCluster }));
vi.mock("@/lib/writeCard", () => ({ writeCard: mocks.writeCard }));
vi.mock("@/lib/rank", () => ({ rankFrontPage: mocks.rankFrontPage }));
vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards,
  claimDigestForGeneration: mocks.claimDigestForGeneration,
  releaseDigestGeneration: mocks.releaseDigestGeneration,
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
}));

function cluster(topic: Topic, id: string): Cluster {
  return {
    topic,
    articles: [
      {
        title: `title-${id}`,
        snippet: "snippet",
        url: `https://example.com/${id}`,
        source: "BBC",
        topic,
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
}

function cardFor(c: Cluster, severity: number): Card {
  return {
    id: `card-${c.articles[0].title}`,
    topic: c.topic,
    title: c.articles[0].title,
    shortSummary: "summary",
    labels: ["Tag"],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-07-31T12:00:00Z",
    generatedAt: "overwritten",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

let logLines: string[];

beforeEach(() => {
  vi.clearAllMocks();
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line === "string") logLines.push(line);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI"], preferredSources: ["BBC"] });
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) =>
    cardFor(c, severity)
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runPostLines(): Promise<Array<Record<string, unknown>>> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** N clusters in one topic, severities descending from 5 then flat at 1. */
function setupTopic(topic: Topic, n: number) {
  const clusters = Array.from({ length: n }, (_, i) => cluster(topic, `${topic}-${i}`));
  mocks.clusterArticles.mockResolvedValue(clusters);
  mocks.triageCluster.mockImplementation(async (c: Cluster) => {
    const i = clusters.indexOf(c);
    return { notable: true, severity: Math.max(1, 5 - i) };
  });
  return clusters;
}

describe("digest route: per-topic card cap", () => {
  it("writes at most MAX_CARDS_PER_TOPIC cards for one topic", async () => {
    setupTopic("Tech/AI", 12);

    await runPostLines();

    expect(mocks.writeCard).toHaveBeenCalledTimes(MAX_CARDS_PER_TOPIC);
  });

  it("caps before the writing event, so the client's progress text is honest", async () => {
    setupTopic("Tech/AI", 12);

    const lines = await runPostLines();
    const writing = lines.find((l) => l.stage === "writing")!;

    // Not 12 — the number the UI renders as "Writing N cards…" must be what
    // actually gets written.
    expect(writing.notableCount).toBe(MAX_CARDS_PER_TOPIC);
  });

  it("caps before expectedCalls, so the cost summary reports no false shortfall", async () => {
    setupTopic("Tech/AI", 12);

    await runPostLines();

    const usage = logLines.filter((l) => l.startsWith("[usage]")).join("\n");
    expect(usage).not.toContain("writeCard recorded");
    expect(usage).not.toContain("were expected");
  });

  it("keeps the highest-severity clusters, not the first ones triaged", async () => {
    const clusters = setupTopic("Tech/AI", 12);

    await runPostLines();

    // Severities run 5,4,3,2,1,1,1,1,1,1,1,1 — the top four are unique and
    // must all survive.
    const written = mocks.writeCard.mock.calls.map((c) => c[0] as Cluster);
    for (const top of clusters.slice(0, 4)) {
      expect(written).toContain(top);
    }
  });

  it("passes each kept cluster's own severity through to writeCard", async () => {
    setupTopic("Tech/AI", 12);

    await runPostLines();

    for (const [c, severity] of mocks.writeCard.mock.calls as [Cluster, number][]) {
      const i = Number(c.articles[0].title.split("-").pop());
      expect(severity).toBe(Math.max(1, 5 - i));
    }
  });

  it("logs what it cut, since the drop is permanent", async () => {
    setupTopic("Tech/AI", 12);

    await runPostLines();

    const line = logLines.find((l) => l.includes("kept") && l.includes("dropped"));
    expect(line).toContain("Tech/AI");
    expect(line).toContain("dropped 4");
  });

  it("leaves a topic under the cap completely untouched", async () => {
    setupTopic("Tech/AI", 3);

    const lines = await runPostLines();

    expect(mocks.writeCard).toHaveBeenCalledTimes(3);
    expect(lines.find((l) => l.stage === "writing")!.notableCount).toBe(3);
    expect(logLines.some((l) => l.includes("dropped"))).toBe(false);
  });

  it("caps each topic independently rather than the digest as a whole", async () => {
    const a = Array.from({ length: 12 }, (_, i) => cluster("Tech/AI", `a-${i}`));
    const b = Array.from({ length: 12 }, (_, i) => cluster("Morocco", `b-${i}`));
    mocks.getUserProfile.mockResolvedValue({
      topics: ["Tech/AI", "Morocco"],
      preferredSources: ["BBC"],
    });
    mocks.clusterArticles.mockResolvedValue([...a, ...b]);
    mocks.triageCluster.mockResolvedValue({ notable: true, severity: 3 });

    await runPostLines();

    const written = mocks.writeCard.mock.calls.map((c) => (c[0] as Cluster).topic);
    expect(written.filter((t) => t === "Tech/AI")).toHaveLength(MAX_CARDS_PER_TOPIC);
    expect(written.filter((t) => t === "Morocco")).toHaveLength(MAX_CARDS_PER_TOPIC);
  });

  it("still reaches done and persists only the capped set", async () => {
    setupTopic("Tech/AI", 12);

    const lines = await runPostLines();

    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");
    const persisted = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(persisted).toHaveLength(MAX_CARDS_PER_TOPIC);
  });
});
