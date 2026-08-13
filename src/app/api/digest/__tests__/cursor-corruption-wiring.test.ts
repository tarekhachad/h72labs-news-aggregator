import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Article, Cluster } from "@/types";

// Integration-style regression test for F.4.4's newest change: unlike
// cursor-wiring.test.ts (which mocks @/lib/ingest entirely and only checks
// that a cursor STRING flows through to it as an argument), this test keeps
// the REAL @/lib/ingest module in the loop -- only rss-parser is mocked, at
// the network boundary -- so the cutoff math itself runs for real, driven
// through the real route.ts POST handler.
//
// What's being verified is the scenario the round's prompt calls out
// explicitly: getLatestGeneratedAtForUser reads the MAX last_generated_at
// across every one of the user's digest rows, but persist_generated_cards
// (supabase/schema.sql) only ever advances the row for the day that ran
// (`where id = p_digest_id`). If some row's last_generated_at were ever
// corrupted to a timestamp days in the future, honouring it as an ordinary
// cutoff would never self-correct -- every future run's cutoff would stay
// in the future no matter how many successful runs complete, silently
// emptying every digest until wall-clock time organically overtook it. The
// FUTURE_CURSOR_TOLERANCE_MS guard in ingest.ts is what's supposed to catch
// this. This test constructs exactly that corrupted-cursor value and
// confirms real articles from a real (mocked-at-the-network-layer) feed
// reach clustering/triage instead of being silently filtered to nothing.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  parseURL: vi.fn(),
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

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
  })),
}));

vi.mock("@/lib/profile", () => ({
  getUserProfile: mocks.getUserProfile,
}));

// @/lib/ingest is deliberately NOT mocked here -- that's the point of this
// file. Only its network dependency (rss-parser, mocked above) is faked.

vi.mock("@/lib/cluster", () => ({
  clusterArticles: mocks.clusterArticles,
}));

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

vi.mock("@/lib/writeCard", () => ({
  writeCard: mocks.writeCard,
}));

vi.mock("@/lib/rank", () => ({
  rankFrontPage: mocks.rankFrontPage,
}));

vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards,
  claimDigestForGeneration: mocks.claimDigestForGeneration,
  releaseDigestGeneration: mocks.releaseDigestGeneration,
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
}));

const NOW = "2026-08-13T12:00:00.000Z";
const HOURS = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(new Date(NOW).getTime() - hours * HOURS).toISOString();
}

/** One BBC Tech/AI feed item per requested age-in-hours. */
function feedWithAges(...ages: number[]) {
  mocks.parseURL.mockResolvedValue({
    items: ages.map((h) => ({
      title: `${h}h`,
      contentSnippet: "snippet",
      link: `https://example.com/${h}`,
      isoDate: hoursAgo(h),
    })),
  });
}

// clusterArticles turned into an identity map (one cluster per surviving
// article) so the test can read straight off what triageClusters receives --
// that's the observable proxy for "which articles survived ingestArticles's
// real cutoff filter."
function identityCluster(articles: Article[]): Cluster[] {
  return articles.map((a) => ({ topic: a.topic, articles: [a] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Tech/AI"],
    preferredSources: ["BBC"],
  });
  mocks.clusterArticles.mockImplementation(async (articles: Article[]) =>
    identityCluster(articles),
  );
  mocks.filterAlreadyCovered.mockImplementation(
    async (clusters: Cluster[]) => clusters,
  );
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
    cs.map(() => ({ notable: false, severity: 1 })),
  );
  mocks.writeCard.mockResolvedValue(undefined);
  mocks.rankFrontPage.mockResolvedValue([]);
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
});

afterEach(() => {
  vi.useRealTimers();
});

async function titlesReachingTriage(): Promise<string[]> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
  // One batched call now carries every cluster, so the titles come from its
  // single argument rather than one call per cluster.
  const batched = (mocks.triageClusters.mock.calls[0]?.[0] ?? []) as Cluster[];
  return batched.map((c) => c.articles[0].title);
}

describe("digest route + real ingest.ts: corrupted far-future cursor recovery", () => {
  it("falls back to the 48h ceiling (not a silently-empty digest) when getLatestGeneratedAtForUser returns a cursor days in the future", async () => {
    // Simulates exactly the failure mode described in ingest.ts's comment:
    // some row's last_generated_at got corrupted to 3 days ahead of now.
    // getLatestGeneratedAtForUser's real query would keep returning this as
    // the max forever (persist_generated_cards only ever advances TODAY's
    // row), so the guard has to catch it at the ingest layer instead.
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(
      new Date(new Date(NOW).getTime() + 72 * HOURS).toISOString(),
    );
    feedWithAges(1, 47, 49, 100);

    // Without the guard, EVERY article's publishedAt (all in the real past)
    // would fail `>= cutoff` against a 3-days-in-the-future cutoff, and
    // nothing would reach clustering/triage at all -- the exact silent
    // failure the guard exists to prevent.
    expect(await titlesReachingTriage()).toEqual(["1h", "47h"]);
  });

  it("honours a merely-skewed (within-tolerance) future cursor instead of falling back, so a fast clock doesn't trigger a full 48h re-ingest", async () => {
    // The other side of the same guard: a writer a few seconds fast must
    // NOT be treated as corrupt, or every subsequent run would re-ingest
    // the full ceiling window -- a permanent duplicate storm.
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(
      new Date(new Date(NOW).getTime() + 60 * 1000).toISOString(),
    );
    feedWithAges(0.5, 1, 47);

    expect(await titlesReachingTriage()).toEqual([]);
  });

  it("uses the real (non-corrupted) cursor as the cutoff on an ordinary later run", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(hoursAgo(6));
    feedWithAges(1, 5, 20, 47);

    expect(await titlesReachingTriage()).toEqual(["1h", "5h"]);
  });
});
