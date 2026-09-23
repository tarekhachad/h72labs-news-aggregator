import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// V2.1.7 made "today" the reader's local day rather than UTC, and the row a
// generation run writes into is chosen by upsertDigestForToday(supabase,
// timeZone). Every other wiring test in this directory mocks getUserProfile
// without a timeZone field at all and mocks upsertDigestForToday itself, so
// none of them would notice if route.ts stopped forwarding profile.timeZone
// -- e.g. a regression back to a hardcoded "UTC", or to no second argument
// at all. This file exists to close that gap: it is the one test in this
// directory that asserts on the actual value passed as the timezone.
//
// Kept minimal by forcing reserveSpend to short-circuit before the pipeline
// starts (status: "error", the same shortcut spend-cap-wiring.test.ts uses
// for its onboarding-incomplete cases) -- the wiring under test happens
// entirely before that point, so the ingest/cluster/triage/writeCard/rank
// stages never need to run or be configured.

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
  reserveSpend: vi.fn(),
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
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
}));
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser,
  releaseGenerationClaim: mocks.releaseGenerationClaim,
}));
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return { ...actual, reserveSpend: mocks.reserveSpend };
});

const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue(null);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: CLAIM_ID });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  // Short-circuits the route right after the wiring under test runs, before
  // the pipeline (which this file doesn't configure) would ever start.
  mocks.reserveSpend.mockResolvedValue({ status: "error" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function runPost(): Promise<Response> {
  const { POST } = await import("@/app/api/digest/route");
  return POST();
}

describe("digest route: the reader's timezone reaches upsertDigestForToday", () => {
  it("forwards the profile's timeZone as the second argument, unmodified", async () => {
    mocks.getUserProfile.mockResolvedValue({
      topics: ["Tech/AI"],
      preferredSources: ["BBC"],
      timeZone: "Africa/Casablanca",
    });

    await runPost();

    expect(mocks.upsertDigestForToday).toHaveBeenCalledWith(expect.anything(), "Africa/Casablanca");
  });

  it("forwards a different reader's different timezone on another request", async () => {
    // Not a redundant re-assertion of the same fact: a wiring bug that
    // hardcodes any single fixed string (correct-looking or not) would still
    // pass the test above if that string happened to match. Only a second,
    // different value can catch that.
    mocks.getUserProfile.mockResolvedValue({
      topics: ["Tech/AI"],
      preferredSources: ["BBC"],
      timeZone: "Pacific/Kiritimati",
    });

    await runPost();

    expect(mocks.upsertDigestForToday).toHaveBeenCalledWith(expect.anything(), "Pacific/Kiritimati");
  });

  it("passes through undefined rather than defaulting, when the profile carries no timeZone", async () => {
    // Documents the current, real gap: every other wiring test in this
    // directory mocks getUserProfile with a return value that has no
    // timeZone field. That is a fine simplification for what those files
    // test, but it means the route is never actually exercised, by any
    // existing test, with the field missing. It is not a bug in route.ts --
    // profile.timeZone is simply read and forwarded, and the real
    // getUserProfile (src/lib/profile.ts, covered separately) always
    // supplies a string, defaulting to "UTC" itself. But nothing stops a
    // future change to route.ts from reading the wrong field name and this
    // silently continuing to "work" in every mocked test while sending
    // `undefined` in production, where dateInTimeZone(now, undefined) is NOT
    // guaranteed to fall back to UTC -- it falls back to the *server's own*
    // default timezone, since Intl.DateTimeFormat treats an undefined
    // `timeZone` option as "use the runtime default", not as an invalid
    // name. Pinned here so that if it starts mattering, this test is the one
    // that already exists to be strengthened.
    mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI"], preferredSources: ["BBC"] });

    await runPost();

    expect(mocks.upsertDigestForToday).toHaveBeenCalledWith(expect.anything(), undefined);
  });
});
