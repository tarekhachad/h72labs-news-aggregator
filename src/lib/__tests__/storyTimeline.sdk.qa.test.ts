import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// linkStories through the REAL Anthropic SDK, with only `fetch` replaced, so
// what the other timeline tests stub out is exercised for real: the request
// the SDK builds from buildParams, `messages.parse` turning the answer into
// parsed_output through zodOutputFormat, and the per-call timeout the SDK
// enforces, which is what keeps the stage inside its budget. No network: the
// fake fetch answers every request itself.

const net = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  const state = {
    mode: "answer" as "answer" | "hang" | "stallBody" | "badJson",
    answerText: '{"match":1}',
    requests: [] as { url: string; body: Record<string, unknown> }[],
  };
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    state.requests.push({ url: href, body: JSON.parse(String(init?.body ?? "{}")) });
    const signal = init?.signal ?? undefined;
    const message = (text: string) =>
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 650, output_tokens: 6 },
      });
    if (state.mode === "answer" || state.mode === "badJson") {
      return new Response(message(state.mode === "answer" ? state.answerText : '{"match":'), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (state.mode === "stallBody") {
      // Headers arrive, then the body never finishes.
      return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Never answers, but gives up the moment it is aborted, as real fetch does.
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  globalThis.fetch = fakeFetch as typeof fetch;
  return { state };
});

const mocks = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock("@/lib/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/embeddings")>("@/lib/embeddings");
  return { embed: mocks.embed, cosineSimilarity: actual.cosineSimilarity };
});

import { CHECK_CONCURRENCY, TIMELINE_BUDGET_MS, linkStories, type StoryCandidate } from "@/lib/storyTimeline";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";

const DIM = 384;
function at(score: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = score;
  v[1] = Math.sqrt(Math.max(0, 1 - score * score));
  return v;
}
const NEW = at(1);
const earlier: StoryCandidate = {
  id: "11111111-1111-4111-8111-111111111111",
  storyId: "22222222-2222-4222-8222-222222222222",
  date: "2026-10-10",
  title: "Talks open in Doha",
  shortSummary: "Delegations met for the first round.",
  embedding: at(0.8),
};
const card = (id: string) => ({ id, title: `Deal agreed ${id}`, shortSummary: "The parties signed." });

beforeEach(() => {
  net.state.mode = "answer";
  net.state.answerText = '{"match":1}';
  net.state.requests = [];
  mocks.embed.mockReset();
  mocks.embed.mockImplementation(async (texts: string[]) => texts.map(() => NEW));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("linkStories through the real SDK (QA)", () => {
  it("sends one Haiku request shaped by buildParams and joins the story from the parsed answer", async () => {
    const usage = createUsageCollector(new Date("2026-10-13T12:00:00Z"));
    const result = await withUsageCollector(usage, () => linkStories([card("x")], "2026-10-13", [earlier]));
    expect(net.state.requests).toHaveLength(1);
    const { url, body } = net.state.requests[0];
    expect(url).toMatch(/\/v1\/messages$/);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.max_tokens).toBe(32);
    expect((body.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect(result.links.get("x")).toEqual({ embedding: NEW, storyId: earlier.storyId });
    expect(result).toMatchObject({ haikuCalls: 1, linked: 1 });
    const calls = usage.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ stage: "timeline", model: "claude-haiku-4-5", tokens: { inputTokens: 650, outputTokens: 6 } });
  });

  it.each([['{"match":0}'], ['{"match":2}'], ['{"match":1.5}'], ['{"nope":1}']])("treats the answer %s as no match", async (text) => {
    net.state.answerText = text;
    const result = await linkStories([card("x")], "2026-10-13", [earlier]);
    expect(result.links.get("x")?.storyId).toBe("x");
    expect(result.haikuCalls).toBe(1);
  });

  it("treats an answer cut off mid-JSON as no match, and still records the call", async () => {
    net.state.mode = "badJson";
    const usage = createUsageCollector(new Date("2026-10-13T12:00:00Z"));
    const result = await withUsageCollector(usage, () => linkStories([card("x")], "2026-10-13", [earlier]));
    expect(result.links.get("x")?.storyId).toBe("x");
    expect(usage.calls()).toHaveLength(1);
  });

  it(
    "ends by the budget when every request hangs: the SDK's own timeout aborts each call",
    async () => {
      net.state.mode = "hang";
      const usage = createUsageCollector(new Date("2026-10-13T12:00:00Z"));
      const cards = Array.from({ length: 40 }, (_, i) => card(`c${i}`));
      const started = Date.now();
      const result = await withUsageCollector(usage, () => linkStories(cards, "2026-10-13", [earlier]));
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(TIMELINE_BUDGET_MS + 2_000);
      // 16 time out at 4 s and 16 more run to the 8 s deadline. A timer can fire a
      // millisecond before Date.now() reaches the deadline, so a few more may
      // start in that last millisecond with a 1 ms timeout; the count stays
      // exact against what was recorded either way.
      expect(result.haikuCalls).toBeGreaterThanOrEqual(CHECK_CONCURRENCY * 2);
      expect(result.haikuCalls).toBeLessThanOrEqual(cards.length);
      expect(usage.calls()).toHaveLength(result.haikuCalls);
      expect(usage.calls().every((c) => c.stage === "timeline" && c.tokens === null && c.bound !== undefined)).toBe(true);
      expect(cards.every((c) => result.links.get(c.id)?.storyId === c.id)).toBe(true);
    },
    20_000
  );

});
