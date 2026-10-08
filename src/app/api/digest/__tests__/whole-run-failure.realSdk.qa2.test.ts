import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { Article, Cluster, Source } from "@/types";
import type { UsageRunRecord } from "@/lib/usageRecord";
import { RUN_FAILED_MESSAGE } from "@/lib/runFailure";

// QA round 2: the whole-run failure guard driven through the REAL Anthropic
// SDK (0.115), the real writeCard, claudeText, recordCall and
// classifyCardFailure. Only `fetch` is faked, so whatever the SDK really throws
// for an HTTP 400/529/connection failure/unparseable body is what the route's
// classifier sees. Triage is real in the "real triage" block and mocked
// elsewhere. No network, no key, no database.

type Handler = (kind: "triage" | "writeCard" | "other", body: Record<string, unknown>, n: number) => Response | Promise<Response>;

const h = vi.hoisted(() => {
  const state = {
    handler: null as null | ((kind: string, body: Record<string, unknown>, n: number) => Response | Promise<Response>),
    calls: [] as { kind: string; model: string }[],
    savedFetch: globalThis.fetch,
    savedKey: process.env.ANTHROPIC_API_KEY,
  };
  // Set before any module that builds an Anthropic client is imported: the
  // SDK captures the global fetch and the key at construction.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const system = String(body.system ?? "");
    const kind = system.startsWith("You write the content for one card")
      ? "writeCard"
      : system.startsWith("You triage news clusters")
        ? "triage"
        : "other";
    state.calls.push({ kind, model: String(body.model) });
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
    useRealTriage: { value: false },
    emitted: [] as UsageRunRecord[],
  };
});

vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({ status: "ok", reservation: { id: "r", token: "t", reservedUsd: 0.7 } })),
    settleSpend: vi.fn(async () => true),
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
// No page fetching: every card writes from its snippets.
vi.mock("@/lib/extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extract")>()),
  extractForStory: vi.fn(async (urls: readonly string[]) => urls.map(() => undefined)),
}));
vi.mock("@/lib/rank", () => ({ rankFrontPage: h.rankFrontPage }));
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

// ---- HTTP fakes ----
function message(text: string, stop = "end_turn", model = "claude-haiku-4-5"): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 120 },
    }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } }
  );
}
function apiError(status: number, type: string, msg: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message: msg } }), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_e", ...headers },
  });
}
const creditOut = () => apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.");
const goodCard = (headline = "Fed Raises Rates Again") =>
  message(JSON.stringify({ title: headline, shortSummary: "The Fed raised rates. Markets fell.", labels: ["Fed"] }));
const truncatedSummary = () =>
  message(JSON.stringify({ title: "X", shortSummary: "The Fed raised rates and then", labels: ["Fed"] }), "max_tokens");
const schemaInvalid = () => message(JSON.stringify({ title: "X", shortSummary: "Done.", labels: ["a", "b", "c"] }));
const brokenJson = () => message('{"title":"X","shortSummary":"The Fed rai', "max_tokens");
const ambiguous = () => message(JSON.stringify({ title: "X", shortSummary: "The Fed raised rates and then", labels: ["Fed"] }), "end_turn");

function article(i: number, source: Source = "BBC"): Article {
  return { title: `Story ${i}`, snippet: "snippet text", url: `https://example.com/${i}/${source}`, source, topic: "Tech/AI" as const, publishedAt: "2026-10-05T12:00:00Z" };
}
const single = (i: number): Cluster => ({ topic: "Tech/AI", articles: [article(i)] });
const multi = (i: number): Cluster => ({ topic: "Tech/AI", articles: [article(i, "BBC"), article(i, "NYT")] });

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

beforeEach(() => {
  vi.clearAllMocks();
  h.state.calls.length = 0;
  h.state.handler = null;
  h.useRealTriage.value = false;
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

function setHandler(fn: Handler) {
  h.state.handler = fn as typeof h.state.handler;
}

describe("real SDK, real writeCard: what classifyCardFailure actually sees", () => {
  it("credit outage (HTTP 400) on every card: classified apiError with status 400, whole run fails, nothing saved", async () => {
    h.clusterArticles.mockResolvedValue([single(1), multi(2)]);
    setHandler(() => creditOut());
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(h.saveGeneratedCards).not.toHaveBeenCalled();
    expect(record.cardFailures).toEqual([
      { reason: "apiError", model: "claude-haiku-4-5", articleCount: 1, status: 400 },
      { reason: "apiError", model: "claude-sonnet-5", articleCount: 2, status: 400 },
    ]);
    // 400 is not retried by the SDK: one request per card.
    expect(h.state.calls.filter((c) => c.kind === "writeCard")).toHaveLength(2);
  });

  it("overloaded (HTTP 529) after the SDK's own retries: apiError status 529, whole run fails", async () => {
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(() => apiError(529, "overloaded_error", "Overloaded", { "retry-after-ms": "1" }));
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.cardFailures?.[0]).toMatchObject({ reason: "apiError", status: 529 });
    expect(h.state.calls.filter((c) => c.kind === "writeCard")).toHaveLength(3);
  });

  it("connection failure (fetch rejects): apiError with no status, whole run fails", async () => {
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(() => {
      throw new TypeError("fetch failed");
    });
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.cardFailures?.[0].reason).toBe("apiError");
    expect(record.cardFailures?.[0]).not.toHaveProperty("status");
  }, 20_000);

  it("a billed 200 whose JSON fails the card schema: classified other (AnthropicError, not APIError), run saves", async () => {
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(() => schemaInvalid());
    const { last, record } = await run();
    expect(last?.stage).toBe("done");
    expect(record.cardFailures?.[0]).toMatchObject({ reason: "other", errorName: "Error" });
    expect(h.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });

  it("a billed 200 cut off mid-JSON at max_tokens: classified other, run saves", async () => {
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(() => brokenJson());
    const { last, record } = await run();
    expect(last?.stage).toBe("done");
    expect(record.cardFailures?.[0].reason).toBe("other");
  });

  it("a billed 200 with a truncated summary: classified truncated, run saves", async () => {
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(() => truncatedSummary());
    const { last, record } = await run();
    expect(last?.stage).toBe("done");
    expect(record.cardFailures?.[0]).toMatchObject({ reason: "truncated", stopReason: "max_tokens" });
  });

  it("every card failed, mix of 400 and a truncated response: saves", async () => {
    h.clusterArticles.mockResolvedValue([single(1), single(2)]);
    setHandler((_k, _b, n) => (n === 1 ? creditOut() : truncatedSummary()));
    const { last, record } = await run();
    expect(last?.stage).toBe("done");
    expect(record.cardFailures?.map((f) => f.reason).sort()).toEqual(["apiError", "truncated"]);
    expect(h.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });

  it("every card failed, mix of 400 and a schema-invalid response (other): saves", async () => {
    h.clusterArticles.mockResolvedValue([single(1), single(2)]);
    setHandler((_k, _b, n) => (n === 1 ? creditOut() : schemaInvalid()));
    const { last, record } = await run();
    expect(last?.stage).toBe("done");
    expect(record.cardFailures?.map((f) => f.reason).sort()).toEqual(["apiError", "other"]);
  });

  it("one 400 and one card written: partial, saves the written card", async () => {
    h.clusterArticles.mockResolvedValue([single(1), single(2)]);
    setHandler((_k, _b, n) => (n === 1 ? creditOut() : goodCard()));
    const { last } = await run();
    expect(last?.stage).toBe("done");
    expect(h.saveGeneratedCards.mock.calls[0][2]).toHaveLength(1);
  });

  it("OBSERVATION: first attempt billed and ambiguous, the retry then hits a 400: classified apiError, whole run fails though a paid call was made", async () => {
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler((_k, _b, n) => (n === 1 ? ambiguous() : creditOut()));
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.cardFailures?.[0].reason).toBe("apiError");
    const writeStage = record.stages.filter((s) => s.stage === "writeCard");
    const measuredCalls = writeStage.reduce((n, s) => n + s.calls, 0);
    process.stdout.write(`[qa2] ambiguous-then-400: writeCard calls with measured (billed) usage = ${measuredCalls}, billed $${record.totalBilledUsd}\n`);
    expect(measuredCalls).toBe(1);
  });

  it("a merged story (two capped clusters merged into one multi-source card) on a 400: apiError on Sonnet, whole run fails", async () => {
    h.clusterArticles.mockResolvedValue([single(1), single(2)]);
    h.mergeDuplicateClusters.mockImplementation(async (items: { cluster: Cluster }[]) => ({
      items: [{ ...items[0], cluster: { ...items[0].cluster, articles: [...items[0].cluster.articles, ...items[1].cluster.articles] } }],
      merged: 1,
      haikuCalls: 0,
    }));
    setHandler(() => creditOut());
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.cardFailures).toEqual([{ reason: "apiError", model: "claude-sonnet-5", articleCount: 2, status: 400 }]);
    expect(h.state.calls).toEqual([{ kind: "writeCard", model: "claude-sonnet-5" }]);
  });

  it("a merged story whose only card is truncated: saves (the refusal rule holds after a merge)", async () => {
    h.clusterArticles.mockResolvedValue([single(1), single(2)]);
    h.mergeDuplicateClusters.mockImplementation(async (items: { cluster: Cluster }[]) => ({
      items: [{ ...items[0], cluster: { ...items[0].cluster, articles: [...items[0].cluster.articles, ...items[1].cluster.articles] } }],
      merged: 1,
      haikuCalls: 0,
    }));
    setHandler(() => truncatedSummary());
    const { last } = await run();
    expect(last?.stage).toBe("done");
  });

  it("a card Claude refuses (stop_reason refusal, no text): classified empty, run saves", async () => {
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(
      () =>
        new Response(
          JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 400, output_tokens: 0 } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const { last, record } = await run();
    expect(last?.stage).toBe("done");
    expect(record.cardFailures?.[0]).toMatchObject({ reason: "empty", stopReason: "refusal" });
  });

  it("rate limited (HTTP 429) after the SDK's retries: apiError 429, whole run fails", async () => {
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(() => apiError(429, "rate_limit_error", "rate limited", { "retry-after-ms": "1" }));
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.cardFailures?.[0]).toMatchObject({ reason: "apiError", status: 429 });
  });

  it("same-day top-up, every new card 400: nothing saved, ranking not run, existing cards untouched", async () => {
    h.getTodaysCardSummaries.mockResolvedValue([
      { id: "e1", topic: "Tech/AI", subtopic: null, shortSummary: "s1", severity: 4, sources: [] },
    ]);
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(() => creditOut());
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.runShape).toBe("sameDayTopUp");
    expect(h.rankFrontPage).not.toHaveBeenCalled();
    expect(h.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("same-day top-up, the only new card truncated: saves and re-ranks", async () => {
    h.getTodaysCardSummaries.mockResolvedValue([
      { id: "e1", topic: "Tech/AI", subtopic: null, shortSummary: "s1", severity: 4, sources: [] },
    ]);
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler(() => truncatedSummary());
    const { last } = await run();
    expect(last?.stage).toBe("done");
    expect(h.rankFrontPage).toHaveBeenCalledTimes(1);
    expect(h.saveGeneratedCards).toHaveBeenCalledTimes(1);
  });
});

describe("real SDK, real triage and real writeCard", () => {
  const triageOk = (body: Record<string, unknown>) => {
    const content = String((body.messages as { content: string }[])[0].content);
    const count = (content.match(/^\d+\. /gm) ?? []).length;
    return message(JSON.stringify({ verdicts: Array.from({ length: count }, (_, index) => ({ index, notable: true, severity: 3, event: `event ${index}` })) }));
  };

  it("credit outage hits triage first: every cluster fails closed, whole run fails, no card is attempted", async () => {
    h.useRealTriage.value = true;
    h.clusterArticles.mockResolvedValue([single(1), single(2), single(3)]);
    setHandler(() => creditOut());
    const { last, record } = await run();
    expect(last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    expect(record.triageFailedClosed).toBe(3);
    expect(h.state.calls.every((c) => c.kind === "triage")).toBe(true);
    process.stdout.write(`[qa2] credit-out, 3 clusters, real SDK: ${h.state.calls.length} triage requests\n`);
  });

  it("triage succeeds, every card hits a persistent 404 (model gone): whole run fails, and each retry re-pays triage", async () => {
    h.useRealTriage.value = true;
    h.clusterArticles.mockResolvedValue([multi(1), multi(2)]);
    setHandler((kind, body) => (kind === "triage" ? triageOk(body) : apiError(404, "not_found_error", "model: claude-sonnet-5")));
    const first = await run();
    const second = await run();
    for (const r of [first, second]) {
      expect(r.last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
      expect(r.record.cardFailures?.every((f) => f.reason === "apiError" && f.status === 404)).toBe(true);
    }
    const billedTriage = [first, second].map((r) => r.record.stages.filter((s) => s.stage === "triage").reduce((n, s) => n + s.calls, 0));
    process.stdout.write(`[qa2] persistent 404 on Sonnet cards: billed triage calls per run = ${billedTriage.join(", ")}; billed $ per run = ${first.record.totalBilledUsd}, ${second.record.totalBilledUsd}\n`);
    expect(billedTriage).toEqual([1, 1]);
    expect(h.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("triage answers but its JSON is cut off every time (billed): one lone cluster fails closed and the whole run fails, run after run", async () => {
    h.useRealTriage.value = true;
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler((kind) => (kind === "triage" ? message('{"verdicts":[{"index":0,"nota', "max_tokens") : goodCard()));
    const first = await run();
    const second = await run();
    for (const r of [first, second]) {
      expect(r.last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
      expect(r.record.triageFailedClosed).toBe(1);
    }
    const triageRequests = h.state.calls.filter((c) => c.kind === "triage").length;
    process.stdout.write(`[qa2] billed-but-unparseable triage, 1 cluster: ${triageRequests} paid triage requests over 2 runs, nothing saved\n`);
    expect(triageRequests).toBe(6);
    expect(h.saveGeneratedCards).not.toHaveBeenCalled();
  });

  it("a lone cluster Haiku refuses to triage (stop_reason refusal, no text, billed): fails closed and the whole run fails, run after run", async () => {
    h.useRealTriage.value = true;
    h.clusterArticles.mockResolvedValue([single(1)]);
    const refusal = () =>
      new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 400, output_tokens: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    setHandler((kind) => (kind === "triage" ? refusal() : goodCard()));
    const first = await run();
    const second = await run();
    for (const r of [first, second]) {
      expect(r.last).toEqual({ stage: "error", message: RUN_FAILED_MESSAGE });
    }
    const billed = [first, second].map((r) => r.record.stages.filter((s) => s.stage === "triage").reduce((n, s) => n + s.calls, 0));
    process.stdout.write(`[qa2] refused lone cluster: measured (billed) triage calls per run = ${billed.join(", ")}\n`);
    expect(billed).toEqual([3, 3]);
  });

  it("triage succeeds on a lone cluster and its card succeeds: saves (sanity for the fake transport)", async () => {
    h.useRealTriage.value = true;
    h.clusterArticles.mockResolvedValue([single(1)]);
    setHandler((kind, body) => (kind === "triage" ? triageOk(body) : goodCard()));
    const { last } = await run();
    expect(last?.stage).toBe("done");
    expect(h.saveGeneratedCards.mock.calls[0][2]).toHaveLength(1);
  });
});
