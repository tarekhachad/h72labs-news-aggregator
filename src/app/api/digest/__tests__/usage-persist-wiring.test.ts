import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";

// Drives the REAL route.ts POST handler through the NDJSON stream, the same
// way usage-wiring.test.ts does, but for the DURABLE record rather than the
// console summary.
//
// What makes this file's existence non-negotiable: the emit is awaited inside
// the generator's finally block, alongside the release of the generation
// mutex. Get the order wrong, or let a sink hang in front of the release, and
// a user is locked out of generating again until the stale-claim window
// expires -- for no reason other than instrumentation. That failure is
// invisible in the happy path and invisible in the types. Only an ordering
// test catches it.
//
// `emitUsageRun` is deliberately NOT mocked. It is the thing that makes a
// hanging sink survivable, so mocking it away would delete the guarantee
// under test and leave a green suite. Only `defaultUsageSinks` is replaced,
// so the sinks are controllable while the real totality logic runs.

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
// Only the sink LIST is swapped. emitUsageRun stays real -- see the header.
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});

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

/** Records written by the run, plus the order of the finally block's steps. */
let emitted: UsageRunRecord[];
let order: string[];

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  order = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Tech/AI", "World"],
    preferredSources: ["BBC"],
  });
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue(FAKE_CLUSTERS);
  mocks.getTodaysCardSummaries.mockResolvedValue([EXISTING_CARD_SUMMARY]);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: CLAIM_ID });
  mocks.releaseGenerationClaim.mockImplementation(async () => {
    order.push("release");
  });
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      order.push("emit");
      emitted.push(record);
    },
  ]);

  mocks.filterAlreadyCovered.mockImplementation(async () => {
    await recordCall("dedup", "claude-haiku-4-5", async () => ({ usage: usage(50) }));
    return FAKE_CLUSTERS;
  });
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) => {
    await recordCall("triage", "claude-haiku-4-5", async () => ({ usage: usage(100) }));
    return cs.map(() => ({ notable: true, severity: 4 }));
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

describe("digest route: the run is recorded durably", () => {
  it("emits exactly one record per run", async () => {
    await runPostToCompletion();
    expect(emitted).toHaveLength(1);
  });

  it("threads the authenticated user's id onto the record", async () => {
    // Never derived from digestId -- that would mean a database round trip
    // inside the finally block.
    await runPostToCompletion();
    expect(emitted[0].userId).toBe("user-42");
    expect(emitted[0].route).toBe("digest");
    expect(emitted[0].digestId).toBe("digest-1");
    expect(emitted[0].cardId).toBeNull();
  });

  it("records the run's measured shape, not just its cost", async () => {
    await runPostToCompletion();

    const record = emitted[0];
    expect(record.outcome).toBe("complete");
    expect(record.label).toBe("digest complete");
    expect(record.topicCount).toBe(2);
    expect(record.sourceCount).toBe(1);
    expect(record.clusterCount).toBe(1);
    expect(record.clustersAfterDedup).toBe(1);
    expect(record.notableCount).toBe(1);
    expect(record.cardsWritten).toBe(1);
    expect(record.cardsFailed).toBe(0);
    expect(record.rankApplied).toBe(true);
    expect(record.totalBilledUsd).toBeGreaterThan(0);
  });

  it("prices the record at the same instant the console summary used", async () => {
    // Two clock readings would let a run spanning a rate change be recorded
    // one way in the log and another in the table.
    await runPostToCompletion();
    expect(emitted[0].pricedAtIso).not.toBeNull();
    expect(emitted[0].clockUsable).toBe(true);
  });

  it("gives each run its own id", async () => {
    await runPostToCompletion();
    await runPostToCompletion();
    expect(emitted).toHaveLength(2);
    expect(emitted[0].runId).not.toBe(emitted[1].runId);
  });
});

describe("digest route: run shape is classified from what the run actually saw", () => {
  it("calls a first-ever run firstEver", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
    mocks.getTodaysCardSummaries.mockResolvedValue([]);

    await runPostToCompletion();

    expect(emitted[0].runShape).toBe("firstEver");
  });

  it("calls a new day's first run firstOfDay", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([]);

    await runPostToCompletion();

    expect(emitted[0].runShape).toBe("firstOfDay");
  });

  it("calls a same-day repeat run sameDayTopUp", async () => {
    // The default fixture: a cursor is set AND today already has a card, so
    // dedup runs and bills. This is the shape V2.0's cap actually consumes.
    await runPostToCompletion();

    expect(emitted[0].runShape).toBe("sameDayTopUp");
  });

  it("calls it unknown when the existing-cards fetch failed", async () => {
    // The warm/warm split turns on today's card count, and that is exactly
    // what could not be read.
    mocks.getTodaysCardSummaries.mockRejectedValue(new Error("db down"));

    await runPostToCompletion();

    expect(emitted[0].runShape).toBe("unknown");
  });

  it("records rankApplied as null when ranking was never attempted", async () => {
    // A deliberate skip is not a failure, and null is what says so.
    mocks.getTodaysCardSummaries.mockRejectedValue(new Error("db down"));

    await runPostToCompletion();

    expect(emitted[0].rankApplied).toBeNull();
  });

  it("records rankApplied as false when ranking was attempted and failed open", async () => {
    mocks.rankFrontPage.mockResolvedValue(null);

    await runPostToCompletion();

    expect(emitted[0].rankApplied).toBe(false);
  });
});

describe("digest route: a run that ends early records what it never learned as null", () => {
  it("leaves fields the run never reached as null, not zero", async () => {
    // Fails during clustering, so nothing downstream was ever measured.
    // cardsWritten: 0 would assert "this run wrote no cards", which is a
    // measurement. It never got there, and that is a different fact.
    mocks.clusterArticles.mockRejectedValue(new Error("embedding model died"));

    await runPostToCompletion();

    const record = emitted[0];
    expect(record.outcome).toBe("endedEarly");
    expect(record.label).toBe("digest ended early (error or cancelled)");
    expect(record.clusterCount).toBeNull();
    expect(record.clustersAfterDedup).toBeNull();
    expect(record.notableCount).toBeNull();
    expect(record.cardsWritten).toBeNull();
    expect(record.cardsFailed).toBeNull();
    expect(record.rankApplied).toBeNull();
    // But what it DID learn before dying is recorded.
    expect(record.articleCount).toBe(0);
    expect(record.topicCount).toBe(2);
  });

  it("still records the spend of a run that dies after paying for triage", async () => {
    mocks.saveGeneratedCards.mockRejectedValue(new Error("db down"));

    await runPostToCompletion();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].outcome).toBe("endedEarly");
    expect(emitted[0].totalBilledUsd).toBeGreaterThan(0);
  });

  it("records a cancelled run too", async () => {
    const res = await runPost();
    await res.body!.cancel();
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    expect(emitted[0].outcome).toBe("endedEarly");
  });

  it("marks the record a floor when a billed call reported no usage", async () => {
    mocks.writeCard.mockImplementation(async () => {
      await recordCall("writeCard", "claude-sonnet-5", async () => ({}));
      return NEW_CARD;
    });

    await runPostToCompletion();

    expect(emitted[0].isFloor).toBe(true);
  });
});

describe("digest route: recording a run can never strand the generation mutex", () => {
  // The whole reason this file exists. Each of these asserts the mutex was
  // released EXACTLY once. At least once is the user not being locked out for
  // the staleness window. Exactly once is the evidence the generator's finally
  // ran one time and one time only -- the same thing the single settle and the
  // single record in this file are evidence of. A double release is no longer
  // dangerous in itself, because a release only matches the token that
  // currently holds the claim, but a finally that runs twice is.

  it("releases the mutex before the record is emitted at all", async () => {
    await runPostToCompletion();

    // Ordering is the guarantee. A try/catch cannot substitute for it,
    // because the failure this defends against is a hang, not a throw.
    expect(order).toEqual(["release", "emit"]);
    expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1);
  });

  it("releases the mutex exactly once when a sink REJECTS", async () => {
    mocks.defaultUsageSinks.mockReturnValue([
      async () => {
        throw new Error("supabase insert exploded");
      },
    ]);

    await runPostToCompletion();

    expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1);
  });

  it("still returns a complete, usable response when a sink rejects", async () => {
    // The user's digest must not be affected by a failure to measure it.
    mocks.defaultUsageSinks.mockReturnValue([
      async () => {
        throw new Error("supabase insert exploded");
      },
    ]);

    const res = await runPost();
    const body = await res.text();

    expect(body).toContain('"stage":"done"');
    expect(body).not.toContain('"stage":"error"');
  });

  it("releases the mutex exactly once when a sink HANGS", async () => {
    // The case a try/catch cannot reach. The sink is still pending when the
    // assertion runs -- if the release were ordered after the emit, it would
    // not have happened yet and this would fail.
    let letSinkFinish: () => void = () => {};
    mocks.defaultUsageSinks.mockReturnValue([
      () =>
        new Promise<void>((resolve) => {
          letSinkFinish = resolve;
        }),
    ]);

    const res = await runPost();
    // Drive the stream without awaiting it: the generator's finally is
    // parked on the hanging sink, so the stream cannot close yet.
    const drained = res.text();

    await vi.waitFor(() => expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1));

    // Let the test exit cleanly rather than leaving work pending.
    letSinkFinish();
    await drained;
    expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1);
  });

  it("releases the mutex exactly once when building the record itself throws", async () => {
    // buildUsageRunRecord runs OUTSIDE emitUsageRun's totality guarantee, so
    // it gets its own guard. Simulated at the nearest reachable seam: the
    // sink list itself failing to be constructed.
    mocks.defaultUsageSinks.mockImplementation(() => {
      throw new Error("could not build the sink list");
    });

    await runPostToCompletion();

    expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1);
  });
});
