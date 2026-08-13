import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";

// Drives the REAL route.ts POST handler end-to-end through the NDJSON
// stream, same pattern as rank-wiring.test.ts. What's under test here is the
// route's cost-instrumentation plumbing: does each pipeline stage run inside
// a collector scope, and does exactly one summary get emitted on every exit
// path — completion, error, and client cancellation alike?
//
// This has to go through POST() rather than calling runDigestPipeline
// directly. The specific hazard being guarded is AsyncLocalStorage context
// being lost across an async generator's yield/next suspension, and that
// only manifests when the generator is actually driven by the stream. Its
// failure mode is a silent $0.00, indistinguishable from a free run.
//
// The collaborators are mocked, so each mock calls recordCall itself — which
// is exactly right: what's being tested is whether the ROUTE establishes the
// scope, not whether the lib modules use it (callSiteUsage.test.ts covers
// that).

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

// Not mocked — the real collector is what's under test.
import { recordCall } from "@/lib/usageCollector";

const FAKE_CLUSTERS: Cluster[] = [
  {
    topic: "Tech/AI",
    articles: [
      {
        title: "A new story",
        snippet: "snippet",
        url: "https://example.com",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  },
];

const NEW_CARD: Card = {
  id: "card-new-1",
  topic: "Tech/AI",
  title: "New card headline",
  shortSummary: "new card summary",
  labels: ["Tag"],
  expandedReport: null,
  sources: [],
  publishedAt: "2026-07-31T12:00:00Z",
  generatedAt: "irrelevant-overwritten-by-route",
  bookmarked: false,
  severity: 4,
  frontPageRank: null,
};

const EXISTING_CARD_SUMMARY = {
  id: "card-existing-1",
  topic: "Tech/AI" as const,
  shortSummary: "existing card summary",
  severity: 2,
};

function usage(inputTokens: number) {
  return {
    input_tokens: inputTokens,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
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
  mocks.clusterArticles.mockResolvedValue(FAKE_CLUSTERS);
  mocks.getTodaysCardSummaries.mockResolvedValue([EXISTING_CARD_SUMMARY]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");

  // Each collaborator bills through the real recordCall, so what the route
  // must supply is the surrounding scope.
  mocks.filterAlreadyCovered.mockImplementation(async () => {
    await recordCall("dedup", "claude-haiku-4-5", async () => ({ usage: usage(50) }));
    return FAKE_CLUSTERS;
  });
  mocks.triageCluster.mockImplementation(async () => {
    await recordCall("triage", "claude-haiku-4-5", async () => ({ usage: usage(100) }));
    return { notable: true, severity: 4 };
  });
  mocks.writeCard.mockImplementation(async () => {
    await recordCall("writeCard", "claude-sonnet-5", async () => ({ usage: usage(1000) }));
    return NEW_CARD;
  });
  mocks.rankFrontPage.mockImplementation(async () => {
    await recordCall("rank", "claude-haiku-4-5", async () => ({ usage: usage(200) }));
    return [3, 1];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runPost(): Promise<Response> {
  const { POST } = await import("@/app/api/digest/route");
  return POST();
}

async function runPostToCompletion(): Promise<void> {
  const res = await runPost();
  await res.text();
}

function summaryLines() {
  return logLines.filter((line) => line.startsWith("[usage]"));
}

function summaryText() {
  return summaryLines().join("\n");
}

/** The header line of the per-stage summary table, one per emitted report. */
function summaryHeaders() {
  return summaryLines().filter((line) => /digest (complete|ended early)/.test(line));
}

describe("digest route: cost instrumentation is wired into every stage", () => {
  it("attributes every stage's calls to the run, through the streamed generator", async () => {
    await runPostToCompletion();

    const text = summaryText();
    // The specific thing that breaks if AsyncLocalStorage doesn't survive
    // the generator: stages silently record nothing and the run reports $0.
    expect(text).toContain("dedup");
    expect(text).toContain("triage");
    expect(text).toContain("writeCard");
    expect(text).toContain("rank");
    expect(text).toContain("digest complete — 4 calls");
  });

  it("emits exactly one summary per run", async () => {
    await runPostToCompletion();
    expect(summaryHeaders()).toHaveLength(1);
  });

  it("reports a nonzero total rather than a silent zero", async () => {
    await runPostToCompletion();
    const total = summaryLines().find((line) => line.includes("TOTAL"));
    expect(total).toBeDefined();
    expect(total).not.toContain("$0.000000");
  });

  it("does not warn about unrecorded calls when every stage reported usage", async () => {
    await runPostToCompletion();
    expect(summaryText()).not.toContain("FLOOR");
  });

  it("still reports what was spent when the run fails after paying for triage", async () => {
    // The persistence failure lands after triage and writeCard have billed.
    mocks.saveGeneratedCards.mockRejectedValue(new Error("db down"));

    await runPostToCompletion();

    expect(summaryHeaders()).toHaveLength(1);
    expect(summaryText()).toContain("digest ended early (error or cancelled)");
    expect(summaryText()).toContain("triage");
    expect(summaryText()).toContain("writeCard");
  });

  it("still reports what was spent when the client disconnects mid-run", async () => {
    // A cancelled run has already paid for whatever completed — the case
    // most likely to go unnoticed, since nothing user-facing reports it.
    const res = await runPost();
    await res.body!.cancel();
    // Let the generator's finally block settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(summaryHeaders()).toHaveLength(1);
    expect(summaryText()).toContain("digest ended early (error or cancelled)");
  });

  it("still releases the generation claim if reporting throws", async () => {
    // The summary must never be able to strand the mutex that gates the
    // user's ability to generate again.
    vi.mocked(console.log).mockImplementation(() => {
      throw new Error("console exploded");
    });

    await runPostToCompletion();

    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });

  it("warns that the total is a floor when a stage's call reported no usage", async () => {
    mocks.triageCluster.mockImplementation(async () => {
      await recordCall("triage", "claude-haiku-4-5", async () => ({}));
      return { notable: true, severity: 4 };
    });

    await runPostToCompletion();

    expect(summaryText()).toContain("FLOOR");
  });

  it("warns loudly when a stage did work but recorded nothing", async () => {
    // The instrumentation-is-broken alarm: writeCard produced a card, so it
    // was definitely billed, yet the collector saw no call for it.
    mocks.writeCard.mockResolvedValue(NEW_CARD);

    await runPostToCompletion();

    expect(summaryText()).toContain("WARNING");
    expect(summaryText()).toContain("writeCard recorded 0 calls but 1 were expected");
  });

  it("counts the extra billed attempt when a stage calls Claude more than once per unit of work", async () => {
    mocks.writeCard.mockImplementation(async () => {
      await recordCall("writeCard", "claude-sonnet-5", async () => ({ usage: usage(1000) }));
      await recordCall("writeCard", "claude-sonnet-5", async () => ({ usage: usage(1000) }));
      return NEW_CARD;
    });

    await runPostToCompletion();

    expect(summaryText()).toContain("writeCard made 2 calls for 1");
  });

  it("does not claim a rank call was expected when the candidate pool is empty", async () => {
    // rankFrontPage short-circuits without touching Claude on an empty pool,
    // so expecting one call would produce a false FLOOR warning.
    mocks.getTodaysCardSummaries.mockResolvedValue([]);
    mocks.triageCluster.mockImplementation(async () => {
      await recordCall("triage", "claude-haiku-4-5", async () => ({ usage: usage(100) }));
      return { notable: false, severity: 1 };
    });
    mocks.rankFrontPage.mockResolvedValue([]);

    await runPostToCompletion();

    expect(summaryText()).not.toContain("rank recorded 0 calls");
  });

  it("reports the introductory-pricing caveat alongside the totals", async () => {
    // The number quoted in the docs has to carry its expiry with it.
    await runPostToCompletion();

    const text = summaryText();
    expect(text).toContain("at list");
    expect(text).toContain("introductory pricing");
  });
});
