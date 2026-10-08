import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Article, Source, Topic } from "@/types";

// The `clustering` event carries a sample of the titles ingest just gathered,
// for the loading animations. Drives the REAL POST handler with the real
// sampler; everything that would touch the network, Claude or the database
// is mocked.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestUnits: vi.fn(),
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
}));

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return { ...actual, reserveSpend: mocks.reserveSpend, settleSpend: vi.fn(async () => true) };
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

function article(title: string, topic: Topic, source: Source): Article {
  return { title, snippet: "", url: `https://example.com/${title}`, source, topic, subtopic: null, publishedAt: "2026-10-08T07:00:00Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Science", "Football"],
    preferredSources: [],
    countries: [],
    timeZone: "UTC",
  });
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue([]);
  mocks.triageClusters.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.filterAlreadyCovered.mockImplementation(async (cs: unknown[]) => cs);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-07T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.reserveSpend.mockResolvedValue({
    status: "ok",
    reservation: { id: "reservation-id", token: "settle-token", reservedUsd: 0.7 },
  });
  mocks.defaultUsageSinks.mockReturnValue([async () => {}]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function events(): Promise<Record<string, unknown>[]> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("digest route: the clustering event's sample titles", () => {
  it("carries a cleaned, spread sample of the gathered titles", async () => {
    mocks.ingestUnits.mockResolvedValue([
      article("Science  one", "Science" as Topic, "BBC" as Source),
      article("Science two", "Science" as Topic, "BBC" as Source),
      article("Football one", "Football" as Topic, "BBC" as Source),
    ]);

    const clustering = (await events()).find((e) => e.stage === "clustering");

    expect(clustering).toEqual({
      stage: "clustering",
      articleCount: 3,
      sampleTitles: ["Science one", "Football one", "Science two"],
    });
  });

  it("carries an empty array when nothing new was gathered", async () => {
    const clustering = (await events()).find((e) => e.stage === "clustering");

    expect(clustering).toEqual({ stage: "clustering", articleCount: 0, sampleTitles: [] });
  });
});
