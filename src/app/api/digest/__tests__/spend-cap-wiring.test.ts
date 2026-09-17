import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Card, Cluster } from "@/types";
import type { Reservation } from "@/lib/spend";

// Drives the REAL digest route through its stream, with the spend module's
// two database calls replaced. What is pinned here is the route's side of
// the cap: a refusal never starts the pipeline, and every way a run can end
// settles its reservation before the generation claim is released.

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
  defaultUsageSinks: vi.fn(),
  reserveSpend: vi.fn(),
  settleSpend: vi.fn(),
}));

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
  claimDigestForGeneration: mocks.claimDigestForGeneration,
  releaseDigestGeneration: mocks.releaseDigestGeneration,
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
}));
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
const RESERVATION: Reservation = { id: "reservation-1", token: TOKEN, reservedUsd: 0.15 };

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
  mocks.claimDigestForGeneration.mockResolvedValue(true);
  mocks.releaseDigestGeneration.mockImplementation(async () => {
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

describe("digest route: spend caps", () => {
  it("reserves after the claim, sized from the profile's topic count", async () => {
    const res = await runPost();
    await res.text();

    expect(mocks.reserveSpend).toHaveBeenCalledWith(expect.anything(), "digest", {
      topicCount: 2,
      ref: "digest-1",
      keepAlive: expect.any(Function),
    });
    expect(mocks.claimDigestForGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reserveSpend.mock.invocationCallOrder[0]
    );
  });

  it("makes no reservation when the claim is refused", async () => {
    mocks.claimDigestForGeneration.mockResolvedValue(false);
    const res = await runPost();
    expect(res.status).toBe(409);
    expect(mocks.reserveSpend).not.toHaveBeenCalled();
  });

  it("refuses at a limit with 429, releases the claim, and never starts the pipeline", async () => {
    mocks.reserveSpend.mockResolvedValue({
      status: "refused",
      reason: "user_count",
      availableAt: "2026-09-18T17:00:00.000Z",
    });

    const res = await runPost();

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      reason: "user_count",
      message: "You've reached your limit of digest runs for now.",
      availableAt: "2026-09-18T17:00:00.000Z",
    });
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledWith(expect.anything(), "digest-1");
    expect(mocks.ingestArticles).not.toHaveBeenCalled();
    expect(mocks.settleSpend).not.toHaveBeenCalled();
  });

  it.each([
    ["the kill switch", { status: "refused", reason: "disabled", availableAt: null }],
    ["a failed check", { status: "error" }],
  ])("answers %s with 503 and never starts the pipeline", async (_label, result) => {
    mocks.reserveSpend.mockResolvedValue(result);

    const res = await runPost();

    expect(res.status).toBe(503);
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
    expect(mocks.ingestArticles).not.toHaveBeenCalled();
  });

  it("settles a completed run to its billed total, before release and before the record", async () => {
    const res = await runPost();
    await res.text();

    expect(mocks.settleSpend).toHaveBeenCalledTimes(1);
    const [reservation, amount] = mocks.settleSpend.mock.calls[0];
    expect(reservation).toEqual(RESERVATION);
    expect(amount).toBeGreaterThan(0);
    expect(amount).toBeLessThan(RESERVATION.reservedUsd);
    expect(order).toEqual(["reserve", "settle", "release", "emit"]);
  });

  it("settles a run that throws mid-pipeline to what it spent", async () => {
    mocks.saveGeneratedCards.mockRejectedValue(new Error("database down"));

    const res = await runPost();
    const text = await res.text();

    expect(text).toContain('"stage":"error"');
    expect(mocks.settleSpend).toHaveBeenCalledTimes(1);
    expect(mocks.settleSpend.mock.calls[0][1]).toBeGreaterThan(0);
    expect(order.indexOf("settle")).toBeLessThan(order.indexOf("release"));
  });

  it("keeps the full reservation for a run whose total is only a floor", async () => {
    mocks.writeCard.mockImplementation(async () => {
      // A call that threw is billed with unknown usage, which makes the run a floor.
      await recordCall("writeCard", "claude-sonnet-5", async () => {
        throw new Error("mid-response failure");
      }).catch(() => {});
      return CARD;
    });

    const res = await runPost();
    await res.text();

    expect(mocks.settleSpend.mock.calls[0][1]).toBe(RESERVATION.reservedUsd);
  });

  it("keeps the full reservation when the cost record cannot be built", async () => {
    vi.spyOn(await import("@/lib/usageRecord"), "buildUsageRunRecord").mockImplementation(() => {
      throw new Error("instrumentation bug");
    });

    const res = await runPost();
    await res.text();

    // settleSpend(null) is what keeps the reservation; it must still be called
    // so the decision is logged, and release must still happen.
    expect(mocks.settleSpend).toHaveBeenCalledWith(RESERVATION, null);
    expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1);
  });

  it("settles a client disconnect after the stream started to what it spent, and releases", async () => {
    const res = await runPost();
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    // cancel() does not wait for the generator's finally; let it run.
    await vi.waitFor(() => expect(mocks.releaseDigestGeneration).toHaveBeenCalledTimes(1));

    expect(mocks.settleSpend).toHaveBeenCalledWith(RESERVATION, 0);
    expect(order.indexOf("settle")).toBeLessThan(order.indexOf("release"));
  });

  it("never sends the settle token to the browser", async () => {
    mocks.saveGeneratedCards.mockRejectedValue(new Error(`failure mentioning nothing secret`));
    const failing = await (await runPost()).text();
    mocks.saveGeneratedCards.mockResolvedValue(undefined);
    const succeeding = await (await runPost()).text();

    expect(failing).not.toContain(TOKEN);
    expect(succeeding).not.toContain(TOKEN);
  });
});

describe("generation claim window", () => {
  it("outlasts the digest route's maximum duration", async () => {
    const { maxDuration } = await import("@/app/api/digest/route");
    const { STALE_CLAIM_MS } = await vi.importActual<typeof import("@/lib/digests")>("@/lib/digests");
    expect(STALE_CLAIM_MS).toBeGreaterThan(maxDuration * 1000);
  });
});
