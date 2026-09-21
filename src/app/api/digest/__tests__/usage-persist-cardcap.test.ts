import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MAX_CARDS_PER_TOPIC } from "@/lib/cardCap";
import type { Card, Cluster, Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";

// Adversarial regression test for a gap found while reviewing the digest
// route's usage-persistence wiring: no test anywhere in the suite asserts a
// concrete non-null value for `cardsDroppedByCap`, and no test asserts
// `notableCount` against a scenario where the cap actually cut something.
// Confirmed by mutation: replacing route.ts's
// `cuts.reduce((sum, cut) => sum + cut.dropped, 0)` with `cuts.length` (a
// plausible off-by-a-lot bug — "number of topics that lost cards" instead of
// "number of cards lost") passed the full 637/639-test suite with zero
// failures. This file pins the real arithmetic across two topics that drop
// different amounts, so that class of bug fails loudly.
//
// A HISTORICAL NOTE, kept because it explains why the sink gate looks the way
// it does. When this file was written, the sibling `card-cap-wiring.test.ts`
// -- which does NOT mock `@/lib/usageSinks` -- invoked the real JSONL sink on
// every run and appended a row to `notes-logs/cost/runs.jsonl` on disk. That
// is no longer true, and nothing here depends on it being true: the gate in
// `defaultUsageSinks` was changed from a denylist (`NODE_ENV !==
// "production"`) to an allowlist (`=== "development"`), so under vitest --
// where NODE_ENV is "test" -- no wiring file can reach the JSONL writer,
// whether or not it mocks the module.
//
// This file still mocks `defaultUsageSinks`, but for a different and simpler
// reason than avoiding disk: it needs to CAPTURE the emitted record in order
// to assert on it.

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
  defaultUsageSinks: vi.fn(),
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

// Stands in for the claim's ownership token. This file only checks that the
// release happens, not which token it carries; spend-cap-wiring.test.ts and
// cursor-wiring.test.ts are where the token itself is asserted.
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

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

let emitted: UsageRunRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: CLAIM_ID });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => cardFor(c, severity));
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runPostToCompletion(): Promise<void> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  await res.text();
}

describe("digest route: cardsDroppedByCap and notableCount are the actual cap arithmetic, not a proxy for it", () => {
  it("sums dropped CARDS across topics, not the count of topics that lost any", async () => {
    // Topic A: 12 clusters -> keeps 8, drops 4. Topic B: 20 clusters -> keeps
    // 8, drops 12. Two topics losing DIFFERENT amounts is what distinguishes
    // "sum of cards dropped" (4 + 12 = 16) from "count of topics cut" (2) or
    // "count of clusters kept" (16, coincidentally equal to notableCount here
    // by construction of these sizes -- picked to make a not-just-negated
    // mutation still fail, since notableCount and cardsDroppedByCap must
    // each be independently correct).
    mocks.getUserProfile.mockResolvedValue({
      topics: ["Tech/AI", "Morocco"],
      preferredSources: ["BBC"],
    });
    const a = Array.from({ length: 12 }, (_, i) => cluster("Tech/AI", `a-${i}`));
    const b = Array.from({ length: 20 }, (_, i) => cluster("Morocco", `b-${i}`));
    mocks.clusterArticles.mockResolvedValue([...a, ...b]);
    mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
      cs.map(() => ({ notable: true, severity: 3 }))
    );

    await runPostToCompletion();

    expect(emitted).toHaveLength(1);
    const record = emitted[0];
    expect(record.notableCount).toBe(2 * MAX_CARDS_PER_TOPIC); // 16: post-cap, what writeCard was asked for
    expect(record.cardsDroppedByCap).toBe(4 + 12); // 16: sum of what each topic actually lost
    expect(record.cardsWritten).toBe(2 * MAX_CARDS_PER_TOPIC);
  });

  it("records cardsDroppedByCap as 0 -- a real measurement, not null -- when nothing was cut", async () => {
    mocks.getUserProfile.mockResolvedValue({
      topics: ["Tech/AI"],
      preferredSources: ["BBC"],
    });
    mocks.clusterArticles.mockResolvedValue([cluster("Tech/AI", "solo")]);
    mocks.triageClusters.mockResolvedValue([{ notable: true, severity: 3 }]);

    await runPostToCompletion();

    expect(emitted[0].cardsDroppedByCap).toBe(0);
    expect(emitted[0].cardsDroppedByCap).not.toBeNull();
    expect(emitted[0].notableCount).toBe(1);
  });
});
