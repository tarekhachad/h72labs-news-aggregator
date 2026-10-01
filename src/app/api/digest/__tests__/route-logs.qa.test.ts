import { describe, it, expect, vi } from "vitest";

// Probe: do the OTHER route log lines that follow billed calls survive a dead console?
// Skipped because both fail today: route.ts's per-topic cap console.log and
// its "writeCard failed" console.error are still unguarded (an open roadmap
// item). Unskip when those two lines go through bestEffortLog.
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
  upsertDigestForToday: mocks.upsertDigestForToday, getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards, getTodaysCardSummaries: mocks.getTodaysCardSummaries }));
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser, releaseGenerationClaim: mocks.releaseGenerationClaim }));

const CL = [{ topic: "Tech/AI", articles: [{ title: "a", snippet: "s", url: "https://e.com", source: "BBC", topic: "Tech/AI", publishedAt: "2026-07-31T12:00:00Z" }] }];
const CARD = { id: "c1", topic: "Tech/AI", title: "T", shortSummary: "s.", labels: [], expandedReport: null, sources: [],
  publishedAt: "2026-07-31T12:00:00Z", generatedAt: "x", bookmarked: false, severity: 4, frontPageRank: null };

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
}
async function run() {
  const { POST } = await import("@/app/api/digest/route");
  const text = await (await POST()).text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe.skip("route logs after billed calls", () => {
  it("a failing writeCard + dead console.error still saves the other paid cards", async () => {
    setup();
    mocks.clusterArticles.mockResolvedValue([CL[0], CL[0]]);
    mocks.filterAlreadyCovered.mockResolvedValue([CL[0], CL[0]]);
    mocks.writeCard.mockResolvedValueOnce(CARD).mockRejectedValueOnce(new Error("bad"));
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      if (typeof m === "string" && m.startsWith("[digest] writeCard failed")) throw new Error("dead");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const lines = await run();
    spy.mockRestore();
    expect(lines.some((l) => l.stage === "error")).toBe(false);
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });
  it("dead console.log on the per-topic cap line does not discard paid triage", async () => {
    setup();
    const many = Array.from({ length: 40 }, () => CL[0]);
    mocks.clusterArticles.mockResolvedValue(many);
    mocks.filterAlreadyCovered.mockResolvedValue(many);
    const spy = vi.spyOn(console, "log").mockImplementation((m) => {
      if (typeof m === "string" && m.startsWith("[digest] Tech/AI: kept")) throw new Error("dead");
    });
    const lines = await run();
    const reached = spy.mock.calls.some(([m]) => typeof m === "string" && m.startsWith("[digest] Tech/AI: kept"));
    spy.mockRestore();
    expect(reached).toBe(true);
    expect(lines.some((l) => l.stage === "error")).toBe(false);
  });
});
