import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FIRST_RUN_CARDS_PER_TOPIC } from "@/lib/cardCap";
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
  triageClusters: vi.fn(),
  writeCard: vi.fn(),
  rankFrontPage: vi.fn(),
  upsertDigestForToday: vi.fn(),
  getLatestGeneratedAtForUser: vi.fn(),
  saveGeneratedCards: vi.fn(),
  claimGenerationForUser: vi.fn(),
  releaseGenerationClaim: vi.fn(),
  getTodaysCardSummaries: vi.fn(),
}));

// Spend caps are not under test here: every reservation is granted and every
// settle succeeds. spend-cap-wiring.test.ts covers them.
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
vi.mock("@/lib/ingest", () => ({ ingestArticles: mocks.ingestArticles }));
vi.mock("@/lib/cluster", () => ({ clusterArticles: mocks.clusterArticles }));
vi.mock("@/lib/dedup", () => ({
  filterAlreadyCovered: mocks.filterAlreadyCovered,
}));
vi.mock("@/lib/triage", async () => {
  // triageBatchCount is pulled through real: it is what the cost summary
  // compares actual calls against, and a mocked-away version returns
  // undefined, which formatUsageSummary skips silently -- the expectation
  // would vanish rather than fail.
  const actual =
    await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  return {
    triageClusters: mocks.triageClusters,
    triageBatchCount: actual.triageBatchCount,
  };
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

// Stands in for the claim's ownership token. This file only checks that the
// release happens, not which token it carries; spend-cap-wiring.test.ts and
// cursor-wiring.test.ts are where the token itself is asserted.
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

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
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Tech/AI"],
    preferredSources: ["BBC"],
  });
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  // Pass-through: the route only calls dedup when the digest already has
  // cards, so this matters to the top-up cases below and not to the
  // first-run ones above.
  mocks.filterAlreadyCovered.mockImplementation(async (clusters: Cluster[]) => clusters);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: CLAIM_ID });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) =>
    cardFor(c, severity),
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
  const clusters = Array.from({ length: n }, (_, i) =>
    cluster(topic, `${topic}-${i}`),
  );
  mocks.clusterArticles.mockResolvedValue(clusters);
  // Severity keyed off each cluster's position in the batch argument, so the
  // cap still gets a distinct ordering to select on.
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
    cs.map((c) => ({
      notable: true,
      severity: Math.max(1, 5 - clusters.indexOf(c)),
    })),
  );
  return clusters;
}

describe("digest route: per-topic card cap", () => {
  it("writes at most FIRST_RUN_CARDS_PER_TOPIC cards for one topic", async () => {
    setupTopic("Tech/AI", 12);

    await runPostLines();

    expect(mocks.writeCard).toHaveBeenCalledTimes(FIRST_RUN_CARDS_PER_TOPIC);
  });

  it("caps before the writing event, so the client's progress text is honest", async () => {
    setupTopic("Tech/AI", 12);

    const lines = await runPostLines();
    const writing = lines.find((l) => l.stage === "writing")!;

    // Not 12 — the number the UI renders as "Writing N cards…" must be what
    // actually gets written.
    expect(writing.notableCount).toBe(FIRST_RUN_CARDS_PER_TOPIC);
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

    for (const [c, severity] of mocks.writeCard.mock.calls as [
      Cluster,
      number,
    ][]) {
      const i = Number(c.articles[0].title.split("-").pop());
      expect(severity).toBe(Math.max(1, 5 - i));
    }
  });

  it("logs what it cut, since the drop is permanent", async () => {
    setupTopic("Tech/AI", 12);

    await runPostLines();

    const line = logLines.find(
      (l) => l.includes("kept") && l.includes("dropped"),
    );
    expect(line).toContain("Tech/AI");
    expect(line).toContain("dropped 4");
    // The kept count comes from the cut, not from a constant. Printed from a
    // constant it would read "kept 8" on a top-up that kept 2.
    expect(line).toContain(`kept ${FIRST_RUN_CARDS_PER_TOPIC} of 12`);
  });

  it("leaves a topic under the cap completely untouched", async () => {
    setupTopic("Tech/AI", 3);

    const lines = await runPostLines();

    expect(mocks.writeCard).toHaveBeenCalledTimes(3);
    expect(lines.find((l) => l.stage === "writing")!.notableCount).toBe(3);
    expect(logLines.some((l) => l.includes("dropped"))).toBe(false);
  });

  it("caps each topic independently rather than the digest as a whole", async () => {
    const a = Array.from({ length: 12 }, (_, i) =>
      cluster("Tech/AI", `a-${i}`),
    );
    const b = Array.from({ length: 12 }, (_, i) =>
      cluster("Morocco", `b-${i}`),
    );
    mocks.getUserProfile.mockResolvedValue({
      topics: ["Tech/AI", "Morocco"],
      preferredSources: ["BBC"],
    });
    mocks.clusterArticles.mockResolvedValue([...a, ...b]);
    mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
      cs.map(() => ({ notable: true, severity: 3 })),
    );

    await runPostLines();

    const written = mocks.writeCard.mock.calls.map(
      (c) => (c[0] as Cluster).topic,
    );
    expect(written.filter((t) => t === "Tech/AI")).toHaveLength(
      FIRST_RUN_CARDS_PER_TOPIC,
    );
    expect(written.filter((t) => t === "Morocco")).toHaveLength(
      FIRST_RUN_CARDS_PER_TOPIC,
    );
  });

  // Everything above is the day's first run: getTodaysCardSummaries is mocked
  // to [] in beforeEach, which makes deriveRunShape say firstOfDay. The tests
  // below are the other run shapes.

  it("adds only the top-up allowance to a topic that already has cards today", async () => {
    setupTopic("Tech/AI", 12);
    mocks.getTodaysCardSummaries.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        id: `existing-${i}`,
        topic: "Tech/AI" as Topic,
        shortSummary: "already covered",
        severity: 3,
      })),
    );

    const lines = await runPostLines();

    expect(mocks.writeCard).toHaveBeenCalledTimes(2);
    expect(lines.find((l) => l.stage === "writing")!.notableCount).toBe(2);
    expect(logLines.find((l) => l.includes("kept"))).toContain("kept 2 of 12");
    expect(mocks.saveGeneratedCards.mock.calls[0][2] as Card[]).toHaveLength(2);
  });

  it("applies the top-up allowance to every topic, not only the ones with cards", async () => {
    const a = Array.from({ length: 12 }, (_, i) => cluster("Tech/AI", `a-${i}`));
    const b = Array.from({ length: 12 }, (_, i) => cluster("Morocco", `b-${i}`));
    mocks.clusterArticles.mockResolvedValue([...a, ...b]);
    mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
      cs.map(() => ({ notable: true, severity: 3 })),
    );
    // Only Tech/AI has cards today; Morocco is still empty.
    mocks.getTodaysCardSummaries.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        id: `existing-${i}`,
        topic: "Tech/AI" as Topic,
        shortSummary: "already covered",
        severity: 3,
      })),
    );

    await runPostLines();

    const written = mocks.writeCard.mock.calls.map((c) => (c[0] as Cluster).topic);
    expect(written.filter((t) => t === "Tech/AI")).toHaveLength(2);
    expect(written.filter((t) => t === "Morocco")).toHaveLength(2);
  });

  it("narrows to the ceiling's headroom for a topic near it", async () => {
    setupTopic("Tech/AI", 12);
    mocks.getTodaysCardSummaries.mockResolvedValue(
      Array.from({ length: 13 }, (_, i) => ({
        id: `existing-${i}`,
        topic: "Tech/AI" as Topic,
        shortSummary: "already covered",
        severity: 3,
      })),
    );

    await runPostLines();

    expect(mocks.writeCard).toHaveBeenCalledTimes(1);
  });

  it("falls back to the top-up allowance when the day's cards cannot be read", async () => {
    setupTopic("Tech/AI", 12);
    mocks.getTodaysCardSummaries.mockRejectedValue(new Error("connection reset"));

    const lines = await runPostLines();

    // Fail closed on spend: an unreadable digest might already be at the
    // ceiling, so this run gets the top-up allowance rather than the full 8.
    expect(mocks.writeCard).toHaveBeenCalledTimes(2);
    expect(lines[lines.length - 1].stage).toBe("done");
  });

  it("keeps the rank result aligned to this run's cards on a top-up", async () => {
    setupTopic("Tech/AI", 12);
    const existingCards = Array.from({ length: 8 }, (_, i) => ({
      id: `existing-${i}`,
      topic: "Tech/AI" as Topic,
      shortSummary: "already covered",
      severity: 3,
    }));
    mocks.getTodaysCardSummaries.mockResolvedValue(existingCards);
    // One rank per candidate: the 8 existing cards then this run's 2.
    mocks.rankFrontPage.mockResolvedValue([null, null, null, null, null, null, null, 1, 2, 3]);

    await runPostLines();

    // The cap shortens the second segment on nearly every top-up, so the
    // offset the route applies has to follow the kept count, not the
    // pre-cap count.
    const persisted = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(persisted).toHaveLength(2);
    expect(persisted.map((c) => c.frontPageRank)).toEqual([2, 3]);
  });

  it("still reaches done and persists only the capped set", async () => {
    setupTopic("Tech/AI", 12);

    const lines = await runPostLines();

    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");
    const persisted = mocks.saveGeneratedCards.mock.calls[0][2] as Card[];
    expect(persisted).toHaveLength(FIRST_RUN_CARDS_PER_TOPIC);
  });
});
