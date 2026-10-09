import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Cluster } from "@/types";
import { unitKey } from "@/lib/readingUnits";

// QA: per-unit read times through the real route, with the real card cap
// fed notable clusters, so the allowance a new unit gets is visible in what
// the cap keeps, not only in the newUnits set it is handed.

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
  getUnitReadTimes: vi.fn(),
  applyCardCap: vi.fn(),
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
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
  })),
}));

vi.mock("@/lib/profile", () => ({
  getUserProfile: mocks.getUserProfile,
}));

vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestUnits: mocks.ingestUnits,
}));

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
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
  getUnitReadTimes: mocks.getUnitReadTimes,
}));

// The real cap, recorded, so the test can see which units it was told are new.
vi.mock("@/lib/cardCap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cardCap")>();
  mocks.applyCardCap.mockImplementation(actual.applyCardCap);
  return { ...actual, applyCardCap: mocks.applyCardCap };
});

vi.mock("@/lib/mergeDuplicates", () => ({
  mergeDuplicateClusters: vi.fn(async (items: unknown[]) => ({ items, merged: 0, haikuCalls: 0 })),
}));

vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser,
  releaseGenerationClaim: mocks.releaseGenerationClaim,
}));

// The claim's ownership token, threaded from claimGenerationForUser to
// releaseGenerationClaim. A release presenting any other token would release
// nothing, so asserting on this value is asserting the route threads it.
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

const FAKE_CLUSTERS: Cluster[] = [
  {
    topic: "Tech/AI",
    articles: [
      {
        title: "A story",
        snippet: "snippet",
        url: "https://example.com",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: ["Tech/AI", "Space"],
    preferredSources: ["BBC"],
  });
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.clusterArticles.mockResolvedValue(FAKE_CLUSTERS);
  mocks.filterAlreadyCovered.mockResolvedValue(FAKE_CLUSTERS);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.triageClusters.mockImplementation(async (cs: Cluster[]) =>
    cs.map(() => ({ notable: false, severity: 1 })),
  );
  mocks.writeCard.mockResolvedValue(undefined);
  mocks.rankFrontPage.mockResolvedValue([]);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: CLAIM_ID });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
  mocks.getUnitReadTimes.mockResolvedValue(new Map([[unitKey("Tech/AI", null), "2026-07-31T10:00:00Z"]]));
});


async function runPost() {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  return res.text();
}

function clustersFor(topic: string, n: number, subtopic?: string): Cluster[] {
  return Array.from({ length: n }, (_, i) => ({
    topic,
    ...(subtopic ? { subtopic } : {}),
    articles: [
      {
        title: `${topic}${subtopic ?? ""} story ${i}`,
        snippet: "s",
        url: `https://example.com/${encodeURIComponent(topic + (subtopic ?? ""))}/${i}`,
        source: "BBC",
        topic,
        ...(subtopic ? { subtopic } : {}),
        publishedAt: "2026-07-31T11:00:00Z",
      },
    ],
  })) as Cluster[];
}

function keptByUnit(): Record<string, number> {
  const { kept } = mocks.applyCardCap.mock.results[0].value as { kept: { cluster: Cluster }[] };
  const counts: Record<string, number> = {};
  for (const k of kept) {
    const key = unitKey(k.cluster.topic, k.cluster.subtopic);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function existing(topic: string, n: number, subtopic: string | null = null) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${topic}-${subtopic}-${i}`,
    topic,
    subtopic,
    shortSummary: "x",
    severity: 3,
    sources: [],
  }));
}

const TECH_KEY = unitKey("Tech/AI", null);
const SPACE_KEY = unitKey("Space", null);

describe("digest route QA: new units through the real cap", () => {
  beforeEach(() => {
    const all = [...clustersFor("Tech/AI", 10), ...clustersFor("Space", 10)];
    mocks.clusterArticles.mockResolvedValue(all);
    mocks.filterAlreadyCovered.mockImplementation(async (cs: Cluster[]) => cs);
    mocks.triageClusters.mockImplementation(async (cs: Cluster[]) => cs.map(() => ({ notable: true, severity: 3 })));
  });

  it("top-up: the new unit gets 8, the read unit gets 2", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue(existing("Tech/AI", 4));
    await runPost();
    expect(mocks.applyCardCap.mock.calls[0][1].runShape).toBe("sameDayTopUp");
    expect(keptByUnit()).toEqual({ [TECH_KEY]: 2, [SPACE_KEY]: 8 });
  });

  it("top-up: a new unit that already has cards today is clamped by the ceiling (14 - 10 = 4)", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([...existing("Tech/AI", 4), ...existing("Space", 10)]);
    await runPost();
    expect(keptByUnit()).toEqual({ [TECH_KEY]: 2, [SPACE_KEY]: 4 });
  });

  it("unknown run shape (today's cards unreadable): a new unit keeps the top-up's 2, like the read unit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getTodaysCardSummaries.mockRejectedValue(new Error("boom"));
    await runPost();
    expect(mocks.applyCardCap.mock.calls[0][1].runShape).toBe("unknown");
    expect(mocks.applyCardCap.mock.calls[0][1].existingCards).toBeNull();
    expect(keptByUnit()).toEqual({ [TECH_KEY]: 2, [SPACE_KEY]: 2 });
  });

  it("lookup failed: no unit is new, both get the top-up's 2, and the units are still saved as read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getTodaysCardSummaries.mockResolvedValue(existing("Tech/AI", 4));
    mocks.getUnitReadTimes.mockRejectedValue(new Error("relation does not exist"));
    await runPost();
    expect(keptByUnit()).toEqual({ [TECH_KEY]: 2, [SPACE_KEY]: 2 });
    // Space was never read but is now marked read at this run: it will not
    // get its full first edition on a later run either.
    expect(mocks.saveGeneratedCards.mock.calls[0][5]).toEqual([
      { topic: "Tech/AI", subtopic: null },
      { topic: "Space", subtopic: null },
    ]);
  });

  it("existing reader with NO read rows at all (e.g. backfill missing): every unit is new on a top-up", async () => {
    mocks.getTodaysCardSummaries.mockResolvedValue([...existing("Tech/AI", 8), ...existing("Space", 8)]);
    mocks.getUnitReadTimes.mockResolvedValue(new Map());
    await runPost();
    const unitSince = mocks.ingestUnits.mock.calls[0][3] as Map<string, string | null>;
    expect([...unitSince.values()]).toEqual([null, null]);
    // each unit gets min(8, 14 - 8) = 6 instead of the top-up's 2
    expect(keptByUnit()).toEqual({ [TECH_KEY]: 6, [SPACE_KEY]: 6 });
  });
});

describe("digest route QA: countries", () => {
  it("keys a country by its subtopic end to end: ingest, cap and save", async () => {
    mocks.getUserProfile.mockResolvedValue({
      topics: ["Tech/AI", "Countries"],
      preferredSources: [],
      countries: ["France", "Kenya"],
    });
    mocks.getUnitReadTimes.mockResolvedValue(
      new Map([
        [unitKey("Tech/AI", null), "2026-07-31T10:00:00Z"],
        [unitKey("Countries", "France"), "2026-07-31T10:00:00Z"],
      ])
    );
    await runPost();
    const unitSince = mocks.ingestUnits.mock.calls[0][3] as Map<string, string | null>;
    expect([...unitSince]).toEqual([
      [unitKey("Tech/AI", null), "2026-07-31T10:00:00Z"],
      [unitKey("Countries", "France"), "2026-07-31T10:00:00Z"],
      [unitKey("Countries", "Kenya"), null],
    ]);
    expect([...(mocks.applyCardCap.mock.calls[0][1].newUnits as Set<string>)]).toEqual([unitKey("Countries", "Kenya")]);
    expect(mocks.saveGeneratedCards.mock.calls[0][5]).toEqual([
      { topic: "Tech/AI", subtopic: null },
      { topic: "Countries", subtopic: "France" },
      { topic: "Countries", subtopic: "Kenya" },
    ]);
  });

  it("a run that fails before saving marks no unit as read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.ingestUnits.mockRejectedValue(new Error("ingest down"));
    await runPost();
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
  });
});
