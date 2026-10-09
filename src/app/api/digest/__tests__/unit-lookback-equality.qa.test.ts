import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Cluster } from "@/types";
import { unitKey } from "@/lib/readingUnits";

// Per-unit read times through the REAL route.ts POST handler: each unit's
// time from getUnitReadTimes reaches ingestUnits, a unit with no time is
// read from the full window and given a first run's card allowance, the
// units read reach the save, and a failed lookup falls back to the run
// cursor for every unit without failing the run.

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
  await res.text();
}

function newUnits(): string[] {
  return [...(mocks.applyCardCap.mock.calls[0][1] as { newUnits: Set<string> }).newUnits];
}

describe("digest route QA: a unit the last run read is never new", () => {
  it("the same instant in two spellings (+00:00 from PostgREST vs Z) is not older than the cursor", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00.123+00:00");
    mocks.getUnitReadTimes.mockResolvedValue(
      new Map([
        [unitKey("Tech/AI", null), "2026-07-31T10:00:00.123Z"],
        [unitKey("Space", null), "2026-07-31T10:00:00.123+00:00"],
      ])
    );

    await runPost();

    expect(newUnits()).toEqual([]);
  });

  it("a unit time later than the run cursor (the cursor written by a later-saving, earlier-stamped run) is not new", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00Z");
    mocks.getUnitReadTimes.mockResolvedValue(
      new Map([
        [unitKey("Tech/AI", null), "2026-07-31T10:00:30Z"],
        [unitKey("Space", null), "2026-07-31T10:00:00Z"],
      ])
    );

    await runPost();

    expect(newUnits()).toEqual([]);
  });

  it("one millisecond older than the cursor is new (the rule is strict)", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-07-31T10:00:00.001Z");
    mocks.getUnitReadTimes.mockResolvedValue(
      new Map([
        [unitKey("Tech/AI", null), "2026-07-31T10:00:00.001Z"],
        [unitKey("Space", null), "2026-07-31T10:00:00.000Z"],
      ])
    );

    await runPost();

    expect(newUnits()).toEqual([unitKey("Space", null)]);
  });

  it("on a first run (no cursor), a unit with a stale row is not counted new but still reads from its own time", async () => {
    mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
    mocks.getUnitReadTimes.mockResolvedValue(new Map([[unitKey("Tech/AI", null), "2026-07-30T10:00:00Z"]]));

    await runPost();

    expect(newUnits()).toEqual([unitKey("Space", null)]);
    const unitSince = mocks.ingestUnits.mock.calls[0][3] as Map<string, string | null>;
    expect(unitSince.get(unitKey("Tech/AI", null))).toBe("2026-07-30T10:00:00Z");
  });
});
