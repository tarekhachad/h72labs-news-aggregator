import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Cluster } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { RUN_FAILED_MESSAGE } from "@/lib/runFailure";
import { settleSpend } from "@/lib/spend";

// The 2026-10-04 incident end to end through the REAL triage module: every
// Anthropic call returns 400 (credit balance too low). The SDK is faked; no
// network. Checks the guard fires and records what the run settles at.

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestUnits: vi.fn(),
  clusterArticles: vi.fn(),
  saveGeneratedCards: vi.fn(),
  releaseGenerationClaim: vi.fn(),
  emitted: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  const Real = actual.default;
  class Fake {
    maxRetries: number;
    constructor(opts?: { maxRetries?: number }) {
      this.maxRetries = opts?.maxRetries ?? 2;
    }
    messages = { parse: mocks.parse, create: mocks.parse };
    static APIError = Real.APIError;
    static APIConnectionError = Real.APIConnectionError;
    static RateLimitError = Real.RateLimitError;
    static BadRequestError = Real.BadRequestError;
  }
  return { ...actual, default: Fake };
});
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({ status: "ok", reservation: { id: "r", token: "t", reservedUsd: 0.7 } })),
    settleSpend: vi.fn(async () => true),
  };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })) }));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestUnits: mocks.ingestUnits,
}));
vi.mock("@/lib/cluster", () => ({ clusterArticles: mocks.clusterArticles }));
vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: vi.fn(async () => ({ digestId: "d" })),
  getLatestGeneratedAtForUser: vi.fn(async () => "2026-10-03T10:00:00Z"),
  saveGeneratedCards: mocks.saveGeneratedCards,
  getTodaysCardSummaries: vi.fn(async () => []),
}));
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: vi.fn(async () => ({ claimId: "11111111-1111-4111-8111-111111111111" })),
  releaseGenerationClaim: mocks.releaseGenerationClaim,
}));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: () => [async (r: unknown) => void mocks.emitted.push(r)] };
});

function clusterN(i: number): Cluster {
  return {
    topic: "Tech/AI",
    articles: [
      { title: `Story ${i}`, snippet: "snippet", url: `https://example.com/${i}`, source: "BBC", topic: "Tech/AI" as const, publishedAt: "2026-10-04T12:00:00Z" },
    ],
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.emitted.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI"], preferredSources: [] });
  mocks.ingestUnits.mockResolvedValue([]);
  const Anthropic = (await import("@anthropic-ai/sdk")).default as unknown as { APIError: new (...a: unknown[]) => Error };
  mocks.parse.mockImplementation(async () => {
    throw new Anthropic.APIError(400, undefined, "Your credit balance is too low", new Headers());
  });
});
afterEach(() => vi.restoreAllMocks());

describe("credit balance out, real triage", () => {
  it.each([3, 45])("%i clusters: run fails as a whole, nothing saved, and the settle amount is reported", async (n) => {
    mocks.clusterArticles.mockResolvedValue(Array.from({ length: n }, (_, i) => clusterN(i)));
    const { POST } = await import("@/app/api/digest/route");
    const res = await POST();
    const events = (await res.text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(events.at(-1)).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(mocks.saveGeneratedCards).not.toHaveBeenCalled();
    expect(mocks.releaseGenerationClaim).toHaveBeenCalledTimes(1);
    const record = mocks.emitted[0] as UsageRunRecord;
    expect(record.outcome).toBe("endedEarly");
    expect(record.triageFailedClosed).toBe(n);
    const amount = vi.mocked(settleSpend).mock.calls[0][1];
    process.stdout.write(`[qa] credit-out, ${n} clusters: ${mocks.parse.mock.calls.length} triage calls, settled at ${amount} of 0.7 reserved\n`);
    expect(amount).not.toBeNull();
  });
});
