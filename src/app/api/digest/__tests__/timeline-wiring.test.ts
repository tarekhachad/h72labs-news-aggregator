import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MODELS } from "@/lib/models";
import { SOURCES, type Card, type Cluster, type Source, type Topic } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import type { StoryCandidate, StoryLink } from "@/lib/storyTimeline";
import { settleSpend } from "@/lib/spend";

// Drives the REAL route POST handler and the REAL story matching, with the
// embedding model, the Anthropic SDK and the database mocked, and checks the
// timeline's place in the run: it reads the reader's earlier cards, saves each
// new card's embedding and story, records its calls under its own stage, and
// streams the new cards with their chips, and the run never fails because of it.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  ingestUnits: vi.fn(),
  clusterArticles: vi.fn(),
  triageClusters: vi.fn(),
  writeCard: vi.fn(),
  rankFrontPage: vi.fn(),
  upsertDigestForToday: vi.fn(),
  getLatestGeneratedAtForUser: vi.fn(),
  saveGeneratedCards: vi.fn(),
  getStoryTimelines: vi.fn(),
  claimGenerationForUser: vi.fn(),
  releaseGenerationClaim: vi.fn(),
  getTodaysCardSummaries: vi.fn(),
  defaultUsageSinks: vi.fn(),
  loadStoryCandidates: vi.fn(),
  countPreferredSources: vi.fn(),
  parse: vi.fn(),
  embed: vi.fn(),
}));

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
const SUPABASE = { auth: { getUser: (...args: unknown[]) => mocks.getUser(...args) } };
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => SUPABASE) }));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestUnits: mocks.ingestUnits,
}));
vi.mock("@/lib/cluster", () => ({ clusterArticles: mocks.clusterArticles }));
vi.mock("@/lib/dedup", () => ({ filterAlreadyCovered: vi.fn(async (cs: Cluster[]) => cs) }));
vi.mock("@/lib/triage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  return { triageClusters: mocks.triageClusters, triageBatchCount: actual.triageBatchCount };
});
vi.mock("@/lib/writeCard", () => ({ writeCard: mocks.writeCard }));
vi.mock("@/lib/rank", () => ({ rankFrontPage: mocks.rankFrontPage }));
vi.mock("@/lib/preferredSources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/preferredSources")>()),
  countPreferredSources: mocks.countPreferredSources,
}));
vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: mocks.upsertDigestForToday,
  getLatestGeneratedAtForUser: mocks.getLatestGeneratedAtForUser,
  saveGeneratedCards: mocks.saveGeneratedCards,
  getTodaysCardSummaries: mocks.getTodaysCardSummaries,
  getStoryTimelines: mocks.getStoryTimelines,
}));
vi.mock("@/lib/storyTimeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storyTimeline")>()),
  loadStoryCandidates: mocks.loadStoryCandidates,
}));
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: mocks.claimGenerationForUser,
  releaseGenerationClaim: mocks.releaseGenerationClaim,
}));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: mocks.defaultUsageSinks };
});
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mocks.parse }, maxRetries: 0 };
  }
  return { default: FakeAnthropic };
});
vi.mock("@/lib/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/embeddings")>("@/lib/embeddings");
  return { embed: mocks.embed, cosineSimilarity: actual.cosineSimilarity };
});

const [OTHER] = SOURCES.slice(0, 1) as Source[];
const VECTOR = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const TODAY = "2026-10-13";

function cluster(label: string, topic: Topic): Cluster {
  return {
    topic,
    articles: [{ title: label, snippet: "", url: `https://example.com/${label}`, source: OTHER, topic, publishedAt: "2026-10-13T08:00:00Z" }],
  };
}

function cardFor(c: Cluster, severity: number): Card {
  return {
    id: `card-${c.articles[0].title}`,
    topic: c.topic,
    title: c.articles[0].title,
    shortSummary: `summary ${c.articles[0].title}`,
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-13T08:00:00Z",
    generatedAt: "overwritten-by-route",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

const EARLIER: StoryCandidate = {
  id: "old-card",
  storyId: "story-1",
  date: "2026-10-10",
  title: "Talks open in Doha",
  shortSummary: "Negotiators met.",
  embedding: VECTOR,
};

let emitted: UsageRunRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-42" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Geopolitics", "Football", "Space"], preferredSources: [], countries: [], timeZone: "UTC" });
  mocks.ingestUnits.mockResolvedValue([]);
  mocks.getTodaysCardSummaries.mockResolvedValue([]);
  mocks.claimGenerationForUser.mockResolvedValue({ claimId: "11111111-1111-4111-8111-111111111111" });
  mocks.releaseGenerationClaim.mockResolvedValue(undefined);
  mocks.saveGeneratedCards.mockResolvedValue(undefined);
  mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1", date: TODAY });
  mocks.getLatestGeneratedAtForUser.mockResolvedValue("2026-10-12T10:00:00Z");
  mocks.rankFrontPage.mockResolvedValue(null);
  mocks.countPreferredSources.mockReturnValue(0);
  mocks.clusterArticles.mockResolvedValue([cluster("ceasefire", "Geopolitics"), cluster("match", "Football")]);
  mocks.triageClusters.mockResolvedValue([
    { notable: true, severity: 4 },
    { notable: true, severity: 3 },
  ]);
  mocks.writeCard.mockImplementation(async (c: Cluster, severity: number) => cardFor(c, severity));
  // The ceasefire card points at the earlier story; the match card points away.
  mocks.embed.mockImplementation(async (texts: string[]) =>
    texts.map((t) => (t.startsWith("ceasefire") ? VECTOR : Array.from({ length: 384 }, (_, i) => (i === 1 ? 1 : 0))))
  );
  mocks.loadStoryCandidates.mockResolvedValue([EARLIER]);
  mocks.parse.mockResolvedValue({ parsed_output: { match: 1 }, stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 7 } });
  mocks.getStoryTimelines.mockImplementation(async (_s: unknown, _u: string, subjects: { id: string; storyId: string | null }[]) =>
    new Map(
      subjects
        .filter((s) => s.storyId === "story-1")
        .map((s) => [s.id, { day: 2, earlier: [{ id: "old-card", date: "2026-10-10", title: "Talks open in Doha", topic: "Geopolitics" }] }])
    )
  );
  mocks.defaultUsageSinks.mockReturnValue([
    async (record: UsageRunRecord) => {
      emitted.push(record);
    },
  ]);
});

afterEach(() => vi.restoreAllMocks());

async function run(): Promise<{ events: Record<string, unknown>[]; record: UsageRunRecord }> {
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(emitted).toHaveLength(1);
  return { events, record: emitted[0] };
}

const savedLinks = () => mocks.saveGeneratedCards.mock.calls[0][6] as Map<string, StoryLink>;
const doneCards = (events: Record<string, unknown>[]) => (events.find((e) => e.stage === "done")?.cards ?? []) as Card[];

describe("digest route: the story timeline", () => {
  it("reads the reader's earlier cards from the digest's own date", async () => {
    await run();
    expect(mocks.loadStoryCandidates).toHaveBeenCalledWith(SUPABASE, "user-42", TODAY);
  });

  it("saves each new card's embedding and story, joining the earlier story Haiku confirmed", async () => {
    await run();
    const links = savedLinks();
    expect(links.get("card-ceasefire")).toEqual({ embedding: VECTOR, storyId: "story-1" });
    expect(links.get("card-match")?.storyId).toBe("card-match");
    expect(links.get("card-match")?.embedding).toHaveLength(384);
  });

  it("records the check under its own stage and expects exactly the calls it made", async () => {
    const { record } = await run();
    expect(record.stages.find((s) => s.stage === "timeline")).toMatchObject({ calls: 1, callsWithoutUsage: 0, model: MODELS.timeline });
    expect(mocks.parse).toHaveBeenCalledTimes(1);
  });

  it("streams the new card with its chip, read once after the save", async () => {
    const { events } = await run();
    const cards = doneCards(events);
    expect(cards.find((c) => c.id === "card-ceasefire")?.timeline?.day).toBe(2);
    expect(cards.find((c) => c.id === "card-match")?.timeline).toBeUndefined();
    expect(mocks.getStoryTimelines).toHaveBeenCalledTimes(1);
    expect(mocks.getStoryTimelines.mock.calls[0][2]).toEqual([
      { id: "card-ceasefire", storyId: "story-1", date: TODAY },
      { id: "card-match", storyId: "card-match", date: TODAY },
    ]);
    expect(mocks.getStoryTimelines.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.saveGeneratedCards.mock.invocationCallOrder[0]);
  });

  it("never sends an embedding to the browser", async () => {
    const { events } = await run();
    expect(JSON.stringify(doneCards(events))).not.toMatch(/embedding/);
  });

  it("reads no timelines when no new card joined a story", async () => {
    mocks.parse.mockResolvedValue({ parsed_output: { match: 0 }, stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 7 } });
    const { events } = await run();
    expect(mocks.getStoryTimelines).not.toHaveBeenCalled();
    expect(events.at(-1)?.stage).toBe("done");
  });

  it("completes when the earlier cards can't be read: every card its own story, still embedded", async () => {
    mocks.loadStoryCandidates.mockRejectedValue(new Error("db down"));
    const { events, record } = await run();
    expect(events.at(-1)?.stage).toBe("done");
    expect([...savedLinks().entries()].map(([id, l]) => [id, l.storyId, l.embedding?.length])).toEqual([
      ["card-ceasefire", "card-ceasefire", 384],
      ["card-match", "card-match", 384],
    ]);
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(record.stages.some((s) => s.stage === "timeline")).toBe(false);
  });

  it("completes when the check fails, recording the failed call", async () => {
    mocks.parse.mockRejectedValue(new Error("529 overloaded"));
    const { events, record } = await run();
    expect(events.at(-1)?.stage).toBe("done");
    expect(savedLinks().get("card-ceasefire")?.storyId).toBe("card-ceasefire");
    expect(record.stages.find((s) => s.stage === "timeline")).toMatchObject({ calls: 0, callsWithoutUsage: 1 });
    expect(settleSpend).toHaveBeenCalledTimes(1);
  });

  it("completes when the timeline read after the save fails", async () => {
    mocks.getStoryTimelines.mockRejectedValue(new Error("db down"));
    const { events } = await run();
    expect(events.at(-1)?.stage).toBe("error");
    // getStoryTimelines never throws in production; a rejection here would be
    // a bug in it, and the save has already happened.
    expect(mocks.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });

  it("does nothing without the digest's date", async () => {
    mocks.upsertDigestForToday.mockResolvedValue({ digestId: "digest-1" });
    const { events } = await run();
    expect(events.at(-1)?.stage).toBe("done");
    expect(mocks.loadStoryCandidates).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(savedLinks().size).toBe(0);
  });

  it("waits for checks still running before it reports and settles a run that fails meanwhile", async () => {
    mocks.parse.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ parsed_output: { match: 1 }, stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 7 } }), 50)
        )
    );
    // Applying the ranks runs while the checks are out; a throw there ends
    // the run with the call still in flight.
    mocks.rankFrontPage.mockResolvedValue(
      new Proxy([], {
        get(target, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) throw new Error("bad rank result");
          return Reflect.get(target, key);
        },
      })
    );
    const { events, record } = await run();
    expect(events.at(-1)?.stage).toBe("error");
    expect(record.stages.find((s) => s.stage === "timeline")).toMatchObject({ calls: 1 });
  });
});
