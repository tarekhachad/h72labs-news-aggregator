import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { MODELS } from "@/lib/models";
import type { Article, Cluster, Source } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { RUN_FAILED_MESSAGE } from "@/lib/runFailure";

// QA (review round 2, Haiku 5.5 switch): the digest route end to end through
// the REAL Anthropic SDK, real writeCard, callModel, recordCall, usage
// pricing, record building and settle amount. Only `fetch` is faked. Covers a
// Haiku 5.5 refusal (with partial JSON) and a long-context card in one run,
// and a run whose every triage call is refused. No network, no database.

type Handler = (kind: "triage" | "writeCard" | "other", body: Record<string, unknown>, n: number) => Response;

const h = vi.hoisted(() => {
  const state = {
    handler: null as null | ((kind: string, body: Record<string, unknown>, n: number) => Response),
    calls: [] as { kind: string; model: string; maxTokens: number }[],
    savedFetch: globalThis.fetch,
    savedKey: process.env.ANTHROPIC_API_KEY,
  };
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const system = String(body.system ?? "");
    const kind = system.startsWith("You write the content for one card") ? "writeCard" : system.startsWith("You triage news clusters") ? "triage" : "other";
    state.calls.push({ kind, model: String(body.model), maxTokens: Number(body.max_tokens) });
    const n = state.calls.filter((c) => c.kind === kind).length;
    if (!state.handler) throw new Error("no handler");
    return state.handler(kind, body, n);
  }) as typeof fetch;
  return {
    state,
    getUser: vi.fn(),
    getUserProfile: vi.fn(),
    ingestUnits: vi.fn(),
    clusterArticles: vi.fn(),
    triageClusters: vi.fn(),
    mergeDuplicateClusters: vi.fn(),
    rankFrontPage: vi.fn(),
    saveGeneratedCards: vi.fn(),
    getTodaysCardSummaries: vi.fn(),
    releaseGenerationClaim: vi.fn(),
    settleSpend: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
    useRealTriage: { value: false },
    useRealRank: { value: false },
    billed: [] as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }[],
    emitted: [] as UsageRunRecord[],
  };
});

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({ status: "ok", reservation: { id: "r", token: "t", reservedUsd: 0.7 } })),
    settleSpend: h.settleSpend,
  };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ auth: { getUser: h.getUser } })) }));
vi.mock("@/lib/profile", () => ({ getUserProfile: h.getUserProfile }));
vi.mock("@/lib/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest")>()),
  ingestUnits: h.ingestUnits,
}));
vi.mock("@/lib/cluster", () => ({ clusterArticles: h.clusterArticles }));
vi.mock("@/lib/dedup", () => ({ filterAlreadyCovered: vi.fn(async (cs: Cluster[]) => cs) }));
vi.mock("@/lib/triage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/triage")>("@/lib/triage");
  return {
    triageBatchCount: actual.triageBatchCount,
    triageClusters: (cs: Cluster[]) => (h.useRealTriage.value ? actual.triageClusters(cs) : h.triageClusters(cs)),
  };
});
vi.mock("@/lib/extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extract")>()),
  extractForStory: vi.fn(async (urls: readonly string[]) => urls.map(() => undefined)),
}));
vi.mock("@/lib/rank", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rank")>("@/lib/rank");
  return {
    ...actual,
    rankFrontPage: (...args: Parameters<typeof actual.rankFrontPage>) =>
      h.useRealRank.value ? actual.rankFrontPage(...args) : h.rankFrontPage(...args),
  };
});
vi.mock("@/lib/mergeDuplicates", () => ({ mergeDuplicateClusters: h.mergeDuplicateClusters }));
vi.mock("@/lib/digests", () => ({
  upsertDigestForToday: vi.fn(async () => ({ digestId: "d" })),
  getLatestGeneratedAtForUser: vi.fn(async () => "2026-10-05T10:00:00Z"),
  saveGeneratedCards: h.saveGeneratedCards,
  getTodaysCardSummaries: h.getTodaysCardSummaries,
}));
vi.mock("@/lib/generationClaim", () => ({
  claimGenerationForUser: vi.fn(async () => ({ claimId: "11111111-1111-4111-8111-111111111111" })),
  releaseGenerationClaim: h.releaseGenerationClaim,
}));
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: () => [async (r: UsageRunRecord) => void h.emitted.push(r)] };
});

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
function reply(content: unknown[], stop: string, usage: Usage, extra: Record<string, unknown> = {}): Response {
  h.billed.push(usage);
  return new Response(
    JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason: stop, stop_sequence: null, usage, ...extra }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } }
  );
}
const cardJson = (title: string) => JSON.stringify({ title, shortSummary: "The Fed raised rates. Markets fell.", labels: ["Fed"] });
const refusal = (usage: Usage, category = "qa_cat") =>
  reply([{ type: "text", text: '{"title":"Fed' }], "refusal", usage, { stop_details: { type: "refusal", category, explanation: null } });

function article(i: number, source: Source = "BBC"): Article {
  return { title: `Story ${i}`, snippet: "snippet text", url: `https://example.com/${i}/${source}`, source, topic: "Tech/AI" as const, publishedAt: "2026-10-05T12:00:00Z" };
}
const single = (i: number): Cluster => ({ topic: "Tech/AI", articles: [article(i)] });
const multi = (i: number): Cluster => ({ topic: "Tech/AI", articles: [article(i, "BBC"), article(i, "NYT")] });

/** Haiku 5.5's bill for one request, typed out from the published card. */
function h55(u: Usage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const [i, o] = u.input_tokens + read > 100_000 ? [0.5, 2.5] : [0.1, 0.5];
  return (u.input_tokens * i + read * i * 0.1 + u.output_tokens * o) / 1_000_000;
}

const AUX: Usage = { input_tokens: 600, output_tokens: 40 };
/** Real triage passes every cluster; real rank answers; anything else is the card handler's. */
function withRealTriageAndRank(cards: (body: Record<string, unknown>) => Response): Handler {
  return (kind, body) => {
    const text = String((body.messages as { content: string }[])[0].content);
    if (kind === "triage") {
      const count = (text.match(/^\d+\. /gm) ?? []).length;
      const verdicts = Array.from({ length: count }, (_, index) => ({ index, notable: true, severity: 3, event: `Event ${index}` }));
      return reply([{ type: "text", text: JSON.stringify({ verdicts }) }], "end_turn", AUX);
    }
    if (kind === "writeCard") return cards(body);
    return reply([{ type: "text", text: '{"picks":[{"index":0,"rank":1}]}' }], "end_turn", AUX);
  };
}
const billedTotal = () => h.billed.reduce((sum, u) => sum + h55(u), 0);

async function run() {
  h.emitted.length = 0;
  const { POST } = await import("@/app/api/digest/route");
  const res = await POST();
  const events = (await res.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { events, record: h.emitted[0], last: events.at(-1) };
}
function lines(): string[] {
  return (["log", "warn", "error", "info"] as const)
    .flatMap((level) => vi.mocked(console[level]).mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.calls.length = 0;
  h.state.handler = null;
  h.useRealTriage.value = false;
  h.useRealRank.value = false;
  h.billed.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  h.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
  h.getUserProfile.mockResolvedValue({ topics: ["Tech/AI"], preferredSources: [] });
  h.ingestUnits.mockResolvedValue([]);
  h.getTodaysCardSummaries.mockResolvedValue([]);
  h.saveGeneratedCards.mockResolvedValue(undefined);
  h.rankFrontPage.mockResolvedValue(null);
  h.mergeDuplicateClusters.mockImplementation(async (items: unknown[]) => ({ items: [...items], merged: 0, haikuCalls: 0 }));
  h.triageClusters.mockImplementation(async (cs: Cluster[]) => cs.map(() => ({ notable: true, severity: 3 })));
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  globalThis.fetch = h.state.savedFetch;
  if (h.state.savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = h.state.savedKey;
});
const setHandler = (fn: Handler) => {
  h.state.handler = fn as typeof h.state.handler;
};

describe("digest route on Haiku 5.5: a refused card and a long-context card in one run", () => {
  const REFUSED: Usage = { input_tokens: 900, output_tokens: 3 };
  const LONG: Usage = { input_tokens: 90_000, cache_read_input_tokens: 20_000, output_tokens: 300 };
  const SHORT: Usage = { input_tokens: 1_000, output_tokens: 200 };

  it("saves the two good cards, records the refusal as empty/refusal, prices the long card long, settles at the exact bill", async () => {
    h.useRealTriage.value = true;
    h.useRealRank.value = true;
    h.clusterArticles.mockResolvedValue([single(1), multi(2), single(3)]);
    setHandler(
      withRealTriageAndRank((body) => {
        const text = JSON.stringify(body.messages);
        if (text.includes("Story 1")) return refusal(REFUSED, "qa_card_cat");
        if (text.includes("Story 2")) return reply([{ type: "text", text: cardJson("Long One") }], "end_turn", LONG);
        return reply([{ type: "text", text: cardJson("Short One") }], "end_turn", SHORT);
      })
    );
    const { last, record } = await run();
    expect(last?.stage).toBe("done");
    expect((last?.cards as unknown[]).length).toBe(2);
    expect(h.saveGeneratedCards.mock.calls[0][2]).toHaveLength(2);
    // Never retried: one request per card.
    const writes = h.state.calls.filter((c) => c.kind === "writeCard");
    expect(writes).toHaveLength(3);
    expect(writes.every((c) => c.model === "claude-haiku-5-5" && c.maxTokens === 2048 + 1024)).toBe(true);
    expect(record.cardFailures).toEqual([
      expect.objectContaining({ reason: "empty", stopReason: "refusal", model: MODELS.writeCardSingle, articleCount: 1 }),
    ]);
    // The category, logged once.
    expect(lines().filter((l) => l.includes("(category: qa_card_cat)"))).toHaveLength(1);
    expect(lines().some((l) => l.includes("Failed to parse structured output"))).toBe(false);
    // Measured, priced per call, not a floor.
    expect(record.isFloor).toBe(false);
    expect(record.totalCallsWithoutUsage).toBe(0);
    const expected = h55(REFUSED) + h55(LONG) + h55(SHORT);
    const row = record.stages.find((s) => s.stage === "writeCard" && s.model === "claude-haiku-5-5")!;
    expect(row.calls).toBe(3);
    expect(row.billedUsd).toBeCloseTo(expected, 15);
    expect(record.totalBilledUsd).toBeCloseTo(billedTotal(), 15);
    expect(h.state.calls.filter((c) => c.kind !== "writeCard").every((c) => c.model === "claude-haiku-5-5")).toBe(true);
    // The long card alone is over half the bill: priced on the dearer card.
    expect(h55(LONG)).toBeGreaterThan(5 * ((90_000 * 0.1 + 20_000 * 0.01 + 300 * 0.5) / 1_000_000) - 1e-12);
    // Settles at the real bill, not the 0.7 hold.
    expect(h.settleSpend).toHaveBeenCalledTimes(1);
    expect(h.settleSpend.mock.calls[0][1] as number).toBeCloseTo(billedTotal(), 15);
  });

  it("every card refused: the run still completes (refusals are not a whole-run failure), nothing written, every refusal billed", async () => {
    h.useRealTriage.value = true;
    h.useRealRank.value = true;
    h.clusterArticles.mockResolvedValue([single(1), single(2)]);
    setHandler(withRealTriageAndRank(() => refusal(REFUSED)));
    const { last, record } = await run();
    // OBSERVATION: the pre-switch "empty" rule, unchanged: only apiError fails the run.
    expect(last?.stage).toBe("done");
    expect(record.cardFailures?.map((f) => f.reason)).toEqual(["empty", "empty"]);
    expect(record.isFloor).toBe(false);
    expect(h.state.calls.filter((c) => c.kind === "writeCard")).toHaveLength(2);
    expect(record.totalBilledUsd).toBeCloseTo(billedTotal(), 15);
    expect(h.settleSpend.mock.calls[0][1] as number).toBeCloseTo(billedTotal(), 15);
  });
});

describe("digest route with real triage on Haiku 5.5", () => {
  it("every triage call refused: whole-run failure, nothing saved, every refused call measured and settled at its bill", async () => {
    h.useRealTriage.value = true;
    h.clusterArticles.mockResolvedValue([single(1), single(2), single(3)]);
    const U: Usage = { input_tokens: 700, output_tokens: 4 };
    setHandler((kind) => {
      if (kind !== "triage") throw new Error(`unexpected ${kind}`);
      return refusal(U, "qa_triage");
    });
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(h.saveGeneratedCards).not.toHaveBeenCalled();
    const triageRequests = h.state.calls.filter((c) => c.kind === "triage");
    expect(triageRequests.length).toBeGreaterThan(1); // the split-retry ladder ran
    expect(triageRequests.every((c) => c.model === "claude-haiku-5-5" && c.maxTokens === 2048 + 1024)).toBe(true);
    expect(record.triageFailedClosed).toBe(3);
    expect(record.totalCallsWithoutUsage).toBe(0);
    expect(record.totalBilledUsd).toBeCloseTo(triageRequests.length * h55(U), 15);
    expect(h.settleSpend.mock.calls[0][1] as number).toBeCloseTo(triageRequests.length * h55(U), 15);
    expect(lines().filter((l) => l.includes("(category: qa_triage)"))).toHaveLength(triageRequests.length);
  });

  it("a long-context triage batch beside a short one: the stage row is the per-call sum, not the summed prompt's card", async () => {
    h.useRealTriage.value = true;
    h.clusterArticles.mockResolvedValue([single(1)]);
    const LONGU: Usage = { input_tokens: 100_001, output_tokens: 50 };
    setHandler((kind, body) => {
      if (kind === "triage") {
        return reply([{ type: "text", text: '{"verdicts":[{"index":0,"notable":false,"severity":1}]}' }], "end_turn", LONGU);
      }
      throw new Error(`unexpected ${kind} ${JSON.stringify(body).slice(0, 40)}`);
    });
    const { record } = await run();
    const row = record.stages.find((s) => s.stage === "triage")!;
    expect(row.model).toBe("claude-haiku-5-5");
    expect(row.billedUsd).toBeCloseTo(h55(LONGU), 15);
    expect(row.billedUsd).toBeCloseTo((100_001 * 0.5 + 50 * 2.5) / 1_000_000, 15);
  });
});
