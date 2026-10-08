import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { Card, Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { RUN_FAILED_MESSAGE } from "@/lib/runFailure";
import { FAIL_CLOSED } from "@/lib/triageOutcome";
import { settleSpend } from "@/lib/spend";
import { GenerationRejectedError } from "@/lib/claudeText";

// QA round 1 for the whole-run failure guard: cleanup on the new throw paths,
// the usage record's counts, same-day top-ups, dedup and the merge step.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestUnits: vi.fn(),
  clusterArticles: vi.fn(),
  filterAlreadyCovered: vi.fn(),
  triageClusters: vi.fn(),
  writeCard: vi.fn(),
  rankFrontPage: vi.fn(),
  mergeDuplicateClusters: vi.fn(),
  upsertDigestForToday: vi.fn(),
  getLatestGeneratedAtForUser: vi.fn(),
  saveGeneratedCards: vi.fn(),
  claimGenerationForUser: vi.fn(),
  releaseGenerationClaim: vi.fn(),
  getTodaysCardSummaries: vi.fn(),
  defaultUsageSinks: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({
      status: "ok",
      reservation: { id: "reservation-id", token: "settle-token", reservedUsd: 0.7 },
    })),
    settleSpend: vi.fn(async () => {
      mocks.order.push("settle");
      return true;
    }),
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
vi.mock("@/lib/mergeDuplicates", () => ({ mergeDuplicateClusters: mocks.mergeDuplicateClusters }));
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

function cluster(title: string): Cluster {
  return {
    topic: "Tech/AI",
    articles: [
      {
        title,
        snippet: "snippet",
        url: `https://example.com/${title}`,
        source: "BBC",
        topic: "Tech/AI" as const,
        publishedAt: "2026-09-24T12:00:00Z",
      },
    ],
  };
}

function card(id: string): Card {
  return {
    id,
    topic: "Tech/AI",
    title: `Headline ${id}`,
    shortSummary: "A summary.",
    labels: ["Tag"],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-09-24T12:00:00Z",
    generatedAt: "x",
    bookmarked: false,
    severity: 3,
    frontPageRank: null,
  };
}

const CLAIM = { claimId: "11111111-1111-4111-8111-111111111111" };
let emitted: UsageRunRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI"], preferredSources: [] });
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue(CLAIM);
  mocks.releaseGenerationClaim.mockImplementation(async () => {
    mocks.order.push("release");
  });
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-09-23T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.mergeDuplicateClusters.mockImplementation(async (items: unknown[]) => ({ items: [...items], merged: 0, haikuCalls: 0 }));
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) => cs.map(() => ({ notable: true, severity: 3 })));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run() {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { events, record: emitted[0] };
}

const creditOut = () => new Anthropic.APIError(400, undefined, "Your credit balance is too low", new Headers());

describe("cleanup on the new throw paths", () => {
  it("every triage verdict failed closed: settles once, then releases the claim, then writes the record", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a"), cluster("b"), cluster("c")]);
    mocks.triageClusters.mockResolvedValue([FAIL_CLOSED, FAIL_CLOSED, FAIL_CLOSED]);
    const { events, record } = await run();
    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(vi.mocked(settleSpend)).toHaveBeenCalledTimes(1);
    expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1);
    expect(mocks.releaseGenerationClaim.mock.calls[0][1]).toEqual(CLAIM);
    expect(mocks.order).toEqual(["settle", "release"]);
    expect(emitted).toHaveLength(1);
    expect(record.outcome).toBe("endedEarly");
    expect(record.clusterCount).toBe(3);
    expect(record.clustersAfterDedup).toBe(3);
    expect(record.triageFailedClosed).toBe(3);
    expect(record.notableCount).toBeNull();
    expect(record.cardsWritten).toBeNull();
    expect(mocks.writeCard).not.toHaveBeenCalled();
    expect(mocks.mergeDuplicateClusters).not.toHaveBeenCalled();
    expect(mocks.rankFrontPage).not.toHaveBeenCalled();
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("every card failed: settles, releases, and the record carries notable/written/failed counts", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a"), cluster("b"), cluster("c")]);
    mocks.triageClusters.mockResolvedValue([{ notable: true, severity: 3 }, { notable: false, severity: 1 }, { notable: true, severity: 4 }]);
    mocks.writeCard.mockRejectedValue(creditOut());
    const { events, record } = await run();
    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(events.map((e) => e.stage)).toContain("writing");
    expect(mocks.order).toEqual(["settle", "release"]);
    expect(record.outcome).toBe("endedEarly");
    expect(record.notableCount).toBe(2);
    expect(record.cardsWritten).toBe(0);
    expect(record.cardsFailed).toBe(2);
    expect(record.cardFailures).toHaveLength(2);
    expect(record.triageFailedClosed).toBe(0);
    expect(mocks.rankFrontPage).not.toHaveBeenCalled();
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("a second run after a whole-run failure can claim again (claim released, not leaked)", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a")]);
    mocks.triageClusters.mockResolvedValueOnce([FAIL_CLOSED]);
    await run();
    mocks.writeCard.mockResolvedValue(card("a"));
    emitted = [];
    mocks.defaultUsageSinks.mockReturnValue([async (r: UsageRunRecord) => void emitted.push(r)]);
    const { events } = await run();
    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(2);
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });
});

describe("same-day top-up (cards already saved today)", () => {
  const existing = [
    { id: "e1", topic: "Tech/AI", subtopic: null, shortSummary: "s1", severity: 4, sources: [] },
    { id: "e2", topic: "Tech/AI", subtopic: null, shortSummary: "s2", severity: 2, sources: [] },
  ];

  it("every card failing on a top-up saves nothing and leaves today's ranks untouched", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue(existing);
    mocks.clusterArticles.mockResolvedValue([cluster("a")]);
    mocks.writeCard.mockRejectedValue(creditOut());
    const { events, record } = await run();
    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(mocks.filterAlreadyCovered).toHaveBeenCalledTimes(1);
    expect(mocks.rankFrontPage).not.toHaveBeenCalled();
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
    expect(record.runShape).toBe("sameDayTopUp");
  });

  it("every triage verdict failing on a top-up saves nothing", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue(existing);
    mocks.clusterArticles.mockResolvedValue([cluster("a"), cluster("b")]);
    mocks.triageClusters.mockResolvedValue([FAIL_CLOSED, FAIL_CLOSED]);
    const { events } = await run();
    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("a top-up whose clusters were all already covered (dedup leaves 0) is a quiet run: saves, re-ranks", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue(existing);
    mocks.clusterArticles.mockResolvedValue([cluster("a"), cluster("b")]);
    mocks.filterAlreadyCovered.mockResolvedValue([]);
    mocks.triageClusters.mockResolvedValue([]);
    const { events } = await run();
    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
    expect(mocks.rankFrontPage).toHaveBeenCalledTimes(1);
  });
});

describe("dedup and the guard's denominator", () => {
  it("dedup leaves one cluster, which fails closed: whole-run failure (the guard counts what went to triage)", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([
      { id: "e1", topic: "Tech/AI", subtopic: null, shortSummary: "s1", severity: 4, sources: [] },
    ]);
    mocks.clusterArticles.mockResolvedValue([cluster("a"), cluster("b"), cluster("c")]);
    mocks.filterAlreadyCovered.mockResolvedValue([cluster("c")]);
    mocks.triageClusters.mockResolvedValue([FAIL_CLOSED]);
    const { events, record } = await run();
    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.clusterCount).toBe(3);
    expect(record.clustersAfterDedup).toBe(1);
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("some fail closed and the rest are judged not notable: saves (partial failure, not whole-run)", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a"), cluster("b"), cluster("c")]);
    mocks.triageClusters.mockResolvedValue([FAIL_CLOSED, FAIL_CLOSED, { notable: false, severity: 1 }]);
    const { events } = await run();
    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
    expect(mocks.writeCard).not.toHaveBeenCalled();
  });
});

describe("the merge step between the cap and writeCard", () => {
  it("three capped stories merged into one, whose card fails: whole-run failure counted against the merged list", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a"), cluster("b"), cluster("c")]);
    mocks.mergeDuplicateClusters.mockImplementation(async (items: unknown[]) => ({ items: [items[0]], merged: 2, haikuCalls: 1 }));
    mocks.writeCard.mockRejectedValue(creditOut());
    const { events, record } = await run();
    expect(mocks.mergeDuplicateClusters.mock.calls[0][0]).toHaveLength(3);
    expect(mocks.writeCard).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.clustersMerged).toBe(2);
    expect(record.notableCount).toBe(1);
    expect(record.cardsFailed).toBe(1);
    expect(vi.mocked(console.error).mock.calls.some((a) => a.some((x) => String(x instanceof Error ? x.message : x).includes("every card failed to write (0/1)")))).toBe(true);
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("merged list of one whose card succeeds: saves", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a"), cluster("b")]);
    mocks.mergeDuplicateClusters.mockImplementation(async (items: unknown[]) => ({ items: [items[0]], merged: 1, haikuCalls: 1 }));
    mocks.writeCard.mockResolvedValue(card("a"));
    const { events } = await run();
    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });
});

describe("what the client is sent", () => {
  it("the error line carries exactly stage and the fixed message, nothing else", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("secret-title")]);
    mocks.writeCard.mockRejectedValue(new Anthropic.APIError(400, undefined, "sk-ant-SECRET internal detail", new Headers()));
    const { events } = await run();
    const last = events.at(-1)!;
    expect(last.stage).toBe("error");
    expect(Object.keys(last).sort()).toEqual(["message", "stage"]);
    const wire = JSON.stringify(events);
    expect(wire).not.toContain("SECRET");
    expect(wire).not.toContain("every card failed");
  });
});

describe("what a whole-run failure settles at (observation)", () => {
  it("reports the settle amount for an every-card-failed run whose card calls carry no usage", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("a")]);
    mocks.writeCard.mockRejectedValue(creditOut());
    await run();
    const amount = vi.mocked(settleSpend).mock.calls[0][1];
    process.stdout.write(`[qa] whole-run failure settle amount (writeCard mocked, no recorded calls): ${amount}\n`);
    expect(vi.mocked(settleSpend)).toHaveBeenCalledTimes(1);
  });
});

describe("a card refused for a non-transient reason", () => {
  // A refused response tends to repeat, so failing the whole run would keep
  // the cursor and send every retry back to the same story.
  it("one notable story whose card is truncated every time: the run saves and moves on", async () => {
    mocks.clusterArticles.mockResolvedValue([cluster("only")]);
    mocks.writeCard.mockRejectedValue(new GenerationRejectedError("m", "truncated", "max_tokens", "tail"));
    const first = await run();
    expect(first.events.at(-1)?.stage).toBe("done");
    expect(first.record.cardFailures?.[0]?.reason).toBe("truncated");
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });
});
