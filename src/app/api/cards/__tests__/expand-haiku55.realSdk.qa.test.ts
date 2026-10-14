import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { UsageRunRecord } from "@/lib/usageRecord";

// QA (review round 2, Haiku 5.5 switch): the expand route end to end through
// the REAL Anthropic SDK and the real cards.ts / callModel / usage pricing /
// settle. Only `fetch` is faked, plus the database and spend RPCs. No
// network, no paid call, no database.

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };

const h = vi.hoisted(() => {
  const state = {
    saved: { fetch: globalThis.fetch, key: process.env.ANTHROPIC_API_KEY },
    bodies: [] as string[],
    reply: null as null | (() => Record<string, unknown>),
  };
  process.env.ANTHROPIC_API_KEY = "qa-not-a-real-key";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    state.bodies.push(String(init?.body ?? ""));
    if (!state.reply) throw new Error("no reply");
    return new Response(
      JSON.stringify({ id: "msg_qa", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_sequence: null, ...state.reply() }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return {
    state,
    getUser: vi.fn(),
    maybeSingle: vi.fn(),
    rpc: vi.fn(),
    settleSpend: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
    emitted: [] as UsageRunRecord[],
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: h.getUser },
    rpc: h.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: h.maybeSingle }) }) }),
  })),
}));
vi.mock("@/lib/spend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/spend")>("@/lib/spend");
  return {
    ...actual,
    reserveSpend: vi.fn(async () => ({ status: "ok", reservation: { id: "r", token: "t".repeat(64), reservedUsd: 0.12 } })),
    settleSpend: h.settleSpend,
  };
});
vi.mock("@/lib/usageSinks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/usageSinks")>("@/lib/usageSinks");
  return { ...actual, defaultUsageSinks: () => [async (r: UsageRunRecord) => void h.emitted.push(r)] };
});
vi.mock("@/lib/extract", async (orig) => {
  const blocked = async (urls: readonly string[]) => urls.map((url) => ({ url, ok: false as const, reason: "robots" as const }));
  return { ...(await orig<typeof import("@/lib/extract")>()), extractArticles: blocked, extractForStory: blocked };
});
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => {} }));

import { POST } from "@/app/api/cards/[id]/expand/route";
import { REQUEST_OVERHEAD_TOKENS } from "@/lib/usage";

const CARD_ID = "11111111-2222-4333-8444-555555555555";
const ROW = {
  id: CARD_ID,
  topic: "Tech/AI",
  short_summary: "A short summary.",
  expanded_report: null,
  sources: [{ title: "T", url: "https://example.com/a", source: "BBC", snippet: "s" }],
};

function h55(u: Usage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const [i, o] = u.input_tokens + read > 100_000 ? [0.5, 2.5] : [0.1, 0.5];
  return (u.input_tokens * i + read * i * 0.1 + u.output_tokens * o) / 1_000_000;
}
const post = () => POST(new Request("http://localhost/api/cards/x/expand", { method: "POST" }), { params: Promise.resolve({ id: CARD_ID }) });
function lines(): string[] {
  return (["log", "warn", "error"] as const)
    .flatMap((level) => vi.mocked(console[level]).mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.bodies = [];
  h.state.reply = null;
  h.emitted.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  h.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  globalThis.fetch = h.state.saved.fetch;
  if (h.state.saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = h.state.saved.key;
});

describe("expand route on Haiku 5.5", () => {
  it("a refusal with partial JSON: 502, nothing persisted, one request, category logged once, settled at the measured bill", async () => {
    const U: Usage = { input_tokens: 1_500, output_tokens: 7 };
    h.state.reply = () => ({
      content: [{ type: "text", text: '{"report":"Some' }],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "qa_expand_cat", explanation: null },
      usage: U,
    });
    const res = await post();
    expect(res.status).toBe(502);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.state.bodies).toHaveLength(1);
    const body = JSON.parse(h.state.bodies[0]) as { model: string; max_tokens: number; thinking: unknown; output_config: { effort: string } };
    expect(body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 4096 + 1024, thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(lines().filter((l) => l.includes("(category: qa_expand_cat)"))).toHaveLength(1);
    expect(lines().some((l) => l.includes("Failed to parse structured output"))).toBe(false);
    const record = h.emitted[0];
    expect(record).toMatchObject({ route: "expand", outcome: "endedEarly", isFloor: false, totalCallsWithoutUsage: 0 });
    expect(record.stages).toEqual([expect.objectContaining({ stage: "expand", model: "claude-haiku-5-5", calls: 1 })]);
    expect(record.totalBilledUsd).toBeCloseTo(h55(U), 15);
    expect(h.settleSpend.mock.calls[0][1] as number).toBeCloseTo(h55(U), 15);
  });

  it("a long-context success: persisted, priced on the long card, settled at that bill", async () => {
    const U: Usage = { input_tokens: 80_000, cache_read_input_tokens: 40_000, output_tokens: 1_200 };
    h.state.reply = () => ({ content: [{ type: "text", text: '{"report":"A complete report."}' }], stop_reason: "end_turn", usage: U });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expandedReport: "A complete report." });
    expect(h.rpc).toHaveBeenCalledWith("set_expanded_report", { p_card_id: CARD_ID, p_report: "A complete report." });
    const longBill = (80_000 * 0.5 + 40_000 * 0.05 + 1_200 * 2.5) / 1_000_000;
    expect(h55(U)).toBeCloseTo(longBill, 15);
    expect(h.emitted[0].totalBilledUsd).toBeCloseTo(longBill, 15);
    expect(h.settleSpend.mock.calls[0][1] as number).toBeCloseTo(longBill, 15);
  });

  it("a billed but unparseable answer: 502, the usage-less call settles at its proven ceiling (below the hold)", async () => {
    h.state.reply = () => ({ content: [{ type: "text", text: '{"report":' }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    const res = await post();
    expect(res.status).toBe(502);
    expect(lines().some((l) => l.includes("Failed to parse structured output"))).toBe(true);
    const record = h.emitted[0];
    expect(record).toMatchObject({ isFloor: true, totalCallsWithoutUsage: 1 });
    const bytes = Buffer.byteLength(h.state.bodies[0], "utf8");
    const attempts = 3; // maxRetries 2 + 1
    const ceiling = attempts * ((bytes + REQUEST_OVERHEAD_TOKENS) * 0.1 + (4096 + 1024) * 0.5) / 1_000_000;
    expect(ceiling).toBeLessThan(0.12);
    expect(h.settleSpend.mock.calls[0][1] as number).toBeCloseTo(ceiling, 15);
  });
});
