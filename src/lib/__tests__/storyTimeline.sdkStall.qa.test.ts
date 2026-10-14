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

import { TIMELINE_BUDGET_MS, linkStories, type StoryCandidate } from "@/lib/storyTimeline";

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

// A known gap, recorded with it.fails so the suite goes red once it is closed:
// the SDK arms its timeout around fetch() only, until the headers arrive, so a
// response whose body then stalls is bounded by nothing in this stage. The
// route awaits the stage (and its finally block awaits it again), so such a
// call holds the run, and the reader's generation claim, past the budget.
describe("linkStories' budget against a stalled response body (QA)", () => {
  it.fails(
    "ends by the budget even when a response's headers arrive and its body stalls",
    async () => {
      net.state.mode = "stallBody";
      const started = Date.now();
      const outcome = await Promise.race([
        linkStories([card("x")], "2026-10-13", [earlier]).then(() => "returned" as const),
        new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), TIMELINE_BUDGET_MS + 3_000)),
      ]);
      expect({ outcome, elapsedUnderBudget: Date.now() - started < TIMELINE_BUDGET_MS + 750 }).toEqual({
        outcome: "returned",
        elapsedUnderBudget: true,
      });
    },
    20_000
  );
});
