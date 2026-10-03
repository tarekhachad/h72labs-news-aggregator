import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";
import type { Reservation } from "@/lib/spend";
import { summarizeUsage, type RecordedCall } from "@/lib/usage";

// QA (v2.4-fair-settle, rounds 1-2). The digest route's side of the fair settle: a floor
// run whose only gap is bounded usage-less calls settles at the proven
// ceiling, and every way that ceiling can't be proven keeps the reservation.

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
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestArticles: mocks.ingestArticles,
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

// The claim's ownership token, threaded from claimGenerationForUser to
// releaseGenerationClaim. A release presenting any other token would release
// nothing, so asserting on this value is asserting the route threads it.
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});
// Only the two database calls are replaced: settleAmount and
// spendRefusalResponse stay real.
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return { ...actual, reserveSpend: mocks.reserveSpend, settleSpend: mocks.settleSpend };
});

import { recordCall } from "@/lib/usageCollector";

const TOKEN = "f".repeat(64);
const RESERVATION: Reservation = { id: "reservation-1", token: TOKEN, reservedUsd: 0.7 };

const CLUSTERS: Cluster[] = [
  {
    topic: "Tech/AI",
    articles: [
      {
        title: "A story",
        snippet: "snippet",
        url: "https://example.com",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-09-17T12:00:00Z",
      },
    ],
  },
];

const CARD: Card = {
  id: "card-1",
  topic: "Tech/AI",
  title: "Headline",
  shortSummary: "summary",
  labels: [],
  expandedReport: null,
  sources: [],
  publishedAt: "2026-09-17T12:00:00Z",
  generatedAt: "overwritten",
  bookmarked: false,
  severity: 4,
  frontPageRank: null,
};

function usage(inputTokens: number) {
  return { input_tokens: inputTokens, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

let order: string[];

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI", "World"], preferredSources: ["BBC"] });
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: CLAIM_ID });
  mocks.releaseGenerationClaim.mockImplementation(async () => {
    order.push("release");
  });
  mocks.reserveSpend.mockImplementation(async () => {
    order.push("reserve");
    return { status: "ok", reservation: RESERVATION };
  });
  mocks.settleSpend.mockImplementation(async () => {
    order.push("settle");
    return true;
  });
  mocks.defaultUsageSinks.mockReturnValue([
    async () => {
      order.push("emit");
    },
  ]);
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue(CLUSTERS);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) => {
    await recordCall("triage", "claude-haiku-4-5", async () => ({ usage: usage(100) }));
    return cs.map(() => ({ notable: true, severity: 4 }));
  });
  mocks.writeCard.mockImplementation(async () => {
    await recordCall("writeCard", "claude-sonnet-5", async () => ({ usage: usage(1000) }));
    return CARD;
  });
  mocks.rankFrontPage.mockImplementation(async () => {
    await recordCall("rank", "claude-haiku-4-5", async () => ({ usage: usage(200) }));
    return [1];
  });
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runPost(): Promise<Response> {
  const { POST } = await import("@/app/api/digest/route");
  return POST();
}


const BOUND = { requestBytes: 6000, maxOutputTokens: 2048, attempts: 3 };
const AT_ANY = new Date();

function measured(stage: RecordedCall["stage"], model: RecordedCall["model"], inputTokens: number): RecordedCall {
  return { stage, model, tokens: { inputTokens, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
}

function twoClusters(): Cluster[] {
  return [CLUSTERS[0], { ...CLUSTERS[0], articles: [{ ...CLUSTERS[0].articles[0], title: "Another", url: "https://example.com/2" }] }];
}

describe("digest route: fair settle of a floor run", () => {
  it("settles at the known total plus the failed call's proven worst case, below the reservation", async () => {
    mocks.writeCard.mockImplementation(async () => {
      await recordCall("writeCard", "claude-sonnet-5", async () => {
        throw new Error("socket hang up");
      }, BOUND);
      return CARD;
    });

    const res = await runPost();
    await res.text();

    const expected = summarizeUsage(
      [
        measured("triage", "claude-haiku-4-5", 100),
        { stage: "writeCard", model: "claude-sonnet-5", tokens: null, bound: BOUND },
        measured("rank", "claude-haiku-4-5", 200),
      ],
      AT_ANY
    );
    const ceiling = expected.totalBilledUsd + expected.unmeasuredBoundUsd!;
    const amount = mocks.settleSpend.mock.calls[0][1] as number;
    expect(amount).toBeCloseTo(ceiling, 12);
    expect(amount).toBeLessThan(RESERVATION.reservedUsd);
    expect(amount).toBeGreaterThan(expected.totalBilledUsd);
  });

  it("keeps the reservation when the failed call carried no bound", async () => {
    mocks.writeCard.mockImplementation(async () => {
      await recordCall("writeCard", "claude-sonnet-5", async () => {
        throw new Error("socket hang up");
      });
      return CARD;
    });

    const res = await runPost();
    await res.text();

    expect(mocks.settleSpend.mock.calls[0][1]).toBe(RESERVATION.reservedUsd);
  });

  it("keeps the reservation when a stage made fewer recorded calls than its work implies, even with every recorded gap bounded", async () => {
    mocks.clusterArticles.mockResolvedValue(twoClusters());
    let n = 0;
    mocks.writeCard.mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        await recordCall("writeCard", "claude-sonnet-5", async () => {
          throw new Error("socket hang up");
        }, BOUND);
      }
      // The second card's call never reached the collector at all.
      return { ...CARD, id: `card-${n}` };
    });

    const res = await runPost();
    await res.text();

    expect(mocks.writeCard).toHaveBeenCalledTimes(2);
    expect(mocks.settleSpend.mock.calls[0][1]).toBe(RESERVATION.reservedUsd);
  });

  it("settles a complete run at its total even when a bound is lying around unused", async () => {
    mocks.writeCard.mockImplementation(async () => {
      await recordCall("writeCard", "claude-sonnet-5", async () => ({ usage: usage(1000) }), BOUND);
      return CARD;
    });

    const res = await runPost();
    await res.text();

    const expected = summarizeUsage(
      [measured("triage", "claude-haiku-4-5", 100), measured("writeCard", "claude-sonnet-5", 1000), measured("rank", "claude-haiku-4-5", 200)],
      AT_ANY
    );
    expect(mocks.settleSpend.mock.calls[0][1]).toBeCloseTo(expected.totalBilledUsd, 12);
  });

  it("settles a 3-attempt usage-less call at three times its single-attempt worst case", async () => {
    const settleWith = async (attempts: number) => {
      vi.clearAllMocks();
      mocks.settleSpend.mockResolvedValue(true);
      mocks.writeCard.mockImplementation(async () => {
        await recordCall("writeCard", "claude-sonnet-5", async () => {
          throw new Error("socket hang up");
        }, { ...BOUND, attempts });
        return CARD;
      });
      const res = await runPost();
      await res.text();
      return mocks.settleSpend.mock.calls[0][1] as number;
    };
    const one = await settleWith(1);
    const three = await settleWith(3);
    const single = summarizeUsage([{ stage: "writeCard", model: "claude-sonnet-5", tokens: null, bound: { ...BOUND, attempts: 1 } }], AT_ANY).unmeasuredBoundUsd!;
    expect(three - one).toBeCloseTo(2 * single, 12);
    expect(three).toBeLessThan(RESERVATION.reservedUsd);
  });

  it("keeps the reservation when the usage-less call's attempt count is not a positive integer", async () => {
    mocks.writeCard.mockImplementation(async () => {
      await recordCall("writeCard", "claude-sonnet-5", async () => {
        throw new Error("socket hang up");
      }, { ...BOUND, attempts: Number.NaN });
      return CARD;
    });
    const res = await runPost();
    await res.text();
    expect(mocks.settleSpend.mock.calls[0][1]).toBe(RESERVATION.reservedUsd);
  });
});
