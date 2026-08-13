import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Card, Cluster, Topic } from "@/types";

// Drives the REAL route POST handler through the NDJSON stream. What's under
// test is the seam batching created: triageClusters returns a flat array of
// outcomes that the route zips back onto survivingClusters by position. The
// unit tests in triage.test.ts prove the module maps batch-local indices to
// global ones; they cannot see whether the ROUTE then pairs outcome i with
// cluster i. A zip that shifted by one would still produce a plausible
// digest -- right number of cards, wrong stories -- so it needs its own
// canary with distinct severities per position, driven through the real
// stream rather than asserted on counts.

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
vi.mock("@/lib/triage", async () => {
  // triageBatchCount pulled through real -- it is what the cost summary
  // compares actual calls against, and a mocked-away version returns
  // undefined, which formatUsageSummary skips silently.
  const actual = await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  return { triageClusters: mocks.triageClusters, triageBatchCount: actual.triageBatchCount };
});
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

function cluster(topic: Topic, title: string): Cluster {
  return {
    topic,
    articles: [
      {
        title,
        snippet: "snippet",
        url: `https://example.com/${title}`,
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
    labels: [],
    sources: [],
    publishedAt: "2026-07-31T12:00:00Z",
    expandedReport: null,
    bookmarked: false,
    severity,
    frontPageRank: null,
    generatedAt: "irrelevant-overwritten-by-route",
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Tech/AI"],
    preferredSources: ["BBC"],
  });
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) =>
    cardFor(c, severity)
  );
  mocks.rankFrontPage.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
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

/** [cluster title, severity] for every writeCard call, in call order. */
function written(): [string, number][] {
  return mocks.writeCard.mock.calls.map((call) => [
    (call[0] as Cluster).articles[0].title,
    call[1] as number,
  ]);
}

describe("digest route: triage outcome alignment (F.4.5)", () => {
  it("ZIP CANARY: pairs each cluster with its own verdict, not a shifted one", async () => {
    const clusters = ["a", "b", "c", "d"].map((t) => cluster("Tech/AI", t));
    mocks.clusterArticles.mockResolvedValue(clusters);
    // Distinct severities, and one rejection in the middle. A shift in
    // either direction changes which titles get written AND what severity
    // each carries, so this fails loudly rather than subtly.
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 5 },
      { notable: false, severity: 1 },
      { notable: true, severity: 3 },
      { notable: true, severity: 2 },
    ]);

    await runPostLines();

    expect(written()).toEqual([
      ["a", 5],
      ["c", 3],
      ["d", 2],
    ]);
  });

  it("ZIP CANARY: alignment holds when the clusters are interleaved across topics", async () => {
    // The batches are per-topic, so the outcome array's order comes from the
    // ORIGINAL cluster order rather than batch order. Interleaving topics is
    // what catches a route that assumed grouped-by-topic ordering.
    const clusters = [
      cluster("Tech/AI", "tech-1"),
      cluster("Morocco", "morocco-1"),
      cluster("Tech/AI", "tech-2"),
      cluster("Morocco", "morocco-2"),
    ];
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.getUserProfile.mockResolvedValue({
      topics: ["Tech/AI", "Morocco"],
      preferredSources: ["BBC"],
    });
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
      { notable: false, severity: 1 },
      { notable: true, severity: 2 },
    ]);

    await runPostLines();

    expect(written()).toEqual([
      ["tech-1", 5],
      ["morocco-1", 4],
      ["morocco-2", 2],
    ]);
  });

  it("passes the surviving clusters to triageClusters in one batched call", async () => {
    const clusters = ["a", "b", "c"].map((t) => cluster("Tech/AI", t));
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue(clusters.map(() => ({ notable: false, severity: 1 })));

    await runPostLines();

    expect(mocks.triageClusters).toHaveBeenCalledTimes(1);
    expect(mocks.triageClusters).toHaveBeenCalledWith(clusters);
  });

  it("reports the cluster count, not the batch count, in the triaging event", async () => {
    // The client renders progress off this number; batching is an
    // implementation detail the user shouldn't see.
    const clusters = Array.from({ length: 30 }, (_, i) => cluster("Tech/AI", `c-${i}`));
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue(clusters.map(() => ({ notable: false, severity: 1 })));

    const lines = await runPostLines();

    const triaging = lines.find((l) => l.stage === "triaging");
    expect(triaging?.clusterCount).toBe(30);
  });

  it("completes the run when triage fails everything closed, rather than erroring", async () => {
    // triageClusters never rejects; a total failure surfaces as every
    // cluster being not-notable. The stream must still reach done with zero
    // cards, and the claim must still be released.
    const clusters = ["a", "b"].map((t) => cluster("Tech/AI", t));
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue([
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
    ]);

    const lines = await runPostLines();

    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(lines[lines.length - 1].stage).toBe("done");
    expect(mocks.writeCard).not.toHaveBeenCalled();
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });

  it("keeps a healthy cluster's card when another cluster failed closed", async () => {
    // Batch-failure isolation as the route sees it: a partial failure inside
    // triageClusters looks exactly like a partial rejection, and the
    // surviving verdicts must still produce their cards.
    const clusters = ["kept", "lost"].map((t) => cluster("Tech/AI", t));
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue([
      { notable: true, severity: 4 },
      { notable: false, severity: 1 },
    ]);

    const lines = await runPostLines();

    expect(written()).toEqual([["kept", 4]]);
    expect(lines[lines.length - 1].stage).toBe("done");
  });
});

describe("digest route: defense-in-depth against a triageClusters contract violation", () => {
  // triageClusters is documented to "never reject" and to always return an
  // array exactly clusters.length long (triage.test.ts pins both). Neither
  // is enforced by the type system at the route's call site -- route.ts
  // indexes into the result positionally with no length check
  // (`outcomes[i].notable`). These tests aren't asking triage.ts to relax
  // that contract; they pin what happens at the ONE remaining seam if it's
  // ever violated by a future change (a bad merge, a bypassed mock in
  // another test, a refactor that reintroduces a throw path) -- the route
  // must still degrade to a clean "error" NDJSON event and release the
  // generation-mutex claim, not crash the whole request unhandled.

  it("surfaces a clean error event instead of an unhandled rejection if triageClusters ever throws", async () => {
    const clusters = ["a", "b"].map((t) => cluster("Tech/AI", t));
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockRejectedValue(new Error("contract violated: threw anyway"));

    const lines = await runPostLines();

    expect(lines[lines.length - 1].stage).toBe("error");
    expect(mocks.writeCard).not.toHaveBeenCalled();
    // The mutex must still be released even on this unexpected path --
    // otherwise the user would be permanently locked out of generating.
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });

  it("surfaces a clean error event rather than misreading a short outcome array as the wrong clusters' verdicts", async () => {
    // If triageClusters ever returned fewer outcomes than clusters (a
    // length-contract violation, not exercised in triage.test.ts because the
    // real module can't produce this), a route with no length guard indexes
    // past the end of the array and reads `undefined.notable`. That must
    // fail loudly into the "error" stream event, not silently skip clusters
    // or crash the process.
    const clusters = ["a", "b", "c"].map((t) => cluster("Tech/AI", t));
    mocks.clusterArticles.mockResolvedValue(clusters);
    mocks.triageClusters.mockResolvedValue([{ notable: true, severity: 5 }]);

    const lines = await runPostLines();

    expect(lines[lines.length - 1].stage).toBe("error");
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });
});
