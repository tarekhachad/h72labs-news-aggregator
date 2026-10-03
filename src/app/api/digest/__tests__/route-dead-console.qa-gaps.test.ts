import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultUsageSinks } from "@/lib/usageSinks";

// QA round 1 gaps: the digest route's remaining degrade-and-continue catches,
// each with a fully dead console. Every one of these sits on a path where a
// throwing log line would turn a run that should finish into a failed one.
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), getUserProfile: vi.fn(), ingestArticles: vi.fn(), clusterArticles: vi.fn(),
  filterAlreadyCovered: vi.fn(), triageClusters: vi.fn(), writeCard: vi.fn(), rankFrontPage: vi.fn(),
  upsertDigestForToday: vi.fn(), getLatestGeneratedAtForUser: vi.fn(), saveGeneratedCards: vi.fn(),
  claimGenerationForUser: vi.fn(), releaseGenerationClaim: vi.fn(), getTodaysCardSummaries: vi.fn(),
}));
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return { ...actual,
    reserveSpend: vi.fn(async () => ({ status: "ok", reservation: { id: "r", token: "t", reservedUsd: 0.7 } })),
    settleSpend: vi.fn(async () => true) };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })) }));
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
  upsertDigestForToday: mocks.upsertDigestForToday, getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards, getTodaysCardSummaries: mocks.getTodaysCardSummaries }));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: vi.fn(() => [async () => {}]) };
});
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser, releaseGenerationClaim: mocks.releaseGenerationClaim }));

const CL = [{ topic: "Tech/AI", articles: [{ title: "a", snippet: "s", url: "https://e.com", source: "BBC", topic: "Tech/AI", publishedAt: "2026-07-31T12:00:00Z" }] }];
const CARD = { id: "c1", topic: "Tech/AI", title: "T", shortSummary: "s.", labels: [], expandedReport: null, sources: [],
  publishedAt: "2026-07-31T12:00:00Z", generatedAt: "x", bookmarked: false, severity: 4, frontPageRank: null };
const EXISTING = [{ id: "e1", topic: "Tech/AI", shortSummary: "earlier story", severity: 3 }];

function setup() {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI"], preferredSources: ["BBC"] });
  mocks.ingestArticles.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue(CL);
  mocks.filterAlreadyCovered.mockResolvedValue(CL);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.triageClusters.mockImplementation(async (cs: unknown[]) => cs.map(() => ({ notable: true, severity: 4 })));
  mocks.writeCard.mockResolvedValue(CARD);
  mocks.rankFrontPage.mockResolvedValue([1]);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "d" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {
      throw new Error("console is dead");
    });
  }
}
afterEach(() => {
  vi.restoreAllMocks();
});
async function run() {
  const { POST } = await import("@/app/api/digest/route");
  const text = await (await POST()).text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function expectFinishedCleanly(lines: { stage: string }[]) {
  expect(lines.some((l) => l.stage === "error")).toBe(false);
  expect(lines.at(-1)?.stage).toBe("done");
  expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1);
}

describe("digest route degrade paths with a dead console", () => {
  it("keeps the paid cards when rankFrontPage throws", async () => {
    setup();
    mocks.rankFrontPage.mockRejectedValue(new Error("rank broke"));
    const lines = await run();
    expectFinishedCleanly(lines);
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
    expect(mocks.saveGeneratedCards.mock.calls[0][2]).toHaveLength(1);
  });

  it("finishes the run when cross-run dedup throws", async () => {
    setup();
    mocks.getTodaysCardSummaries.mockResolvedValue(EXISTING);
    mocks.filterAlreadyCovered.mockRejectedValue(new Error("dedup broke"));
    const lines = await run();
    expectFinishedCleanly(lines);
    expect(mocks.writeCard).toHaveBeenCalledTimes(1);
  });

  it("finishes the run when today's existing cards can't be loaded", async () => {
    setup();
    mocks.getTodaysCardSummaries.mockRejectedValue(new Error("db down"));
    const lines = await run();
    expectFinishedCleanly(lines);
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });

  it("does not append an error event after done when building the cost sinks throws", async () => {
    setup();
    vi.mocked(defaultUsageSinks).mockImplementationOnce(() => {
      throw new Error("sinks broke");
    });
    const lines = await run();
    expectFinishedCleanly(lines);
  });
});
