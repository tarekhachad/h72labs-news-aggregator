import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// QA (review-loop round 2, v2.4-fair-settle). FINDING, written as the
// invariant ("the settle is never below what the run could have been
// billed"), so it is red while the gap exists.
//
// A call whose first attempt dies at the connection (the server may already
// have generated and billed it) and whose retry succeeds records only the
// retry's usage. The run is a floor because a different call reported no
// usage, so it now takes the fair-settle path, whose ceiling covers the
// usage-less call's attempts but not the measured call's hidden one.

const sent: string[] = [];
let script: (() => Promise<Response>)[] = [];

const OK_BODY = {
  id: "msg_qa",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: JSON.stringify({ sameStory: true }) }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 400, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

let mods: {
  collector: typeof import("@/lib/usageCollector");
  usage: typeof import("@/lib/usage");
  usageRecord: typeof import("@/lib/usageRecord");
  spend: typeof import("@/lib/spend");
  dedup: typeof import("@/lib/dedup");
};

beforeAll(async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "qa-not-a-real-key");
  vi.stubEnv("ANTHROPIC_BASE_URL", "http://qa.invalid");
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    sent.push(typeof init.body === "string" ? init.body : "");
    const next = script.shift();
    if (!next) throw new Error("qa: unscripted request");
    return next();
  });
  vi.resetModules();
  mods = {
    collector: await import("@/lib/usageCollector"),
    usage: await import("@/lib/usage"),
    usageRecord: await import("@/lib/usageRecord"),
    spend: await import("@/lib/spend"),
    dedup: await import("@/lib/dedup"),
  };
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AT = new Date("2026-10-03T12:00:00Z");
const dropped = async (): Promise<Response> => {
  throw new TypeError("fetch failed: socket hang up");
};

function worstCaseOf(body: string): number {
  const cost = mods.usage.costFor(
    "claude-haiku-4-5",
    {
      inputTokens: Buffer.byteLength(body, "utf8") + mods.usage.REQUEST_OVERHEAD_TOKENS,
      outputTokens: JSON.parse(body).max_tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    AT
  );
  return Math.max(cost.billedUsd, cost.listUsd);
}

// A known, accepted gap (decision log, 2026-10-03): a measured call whose
// earlier attempt was billed and then retried successfully reports only its
// last attempt, so a floor run's ceiling can sit a few cents below the bill.
// `it.fails` keeps the invariant written down; when per-call attempt counting
// lands (roadmap Track B), this flips to a passing `it`.
describe("a floor run whose measured call hid a retried attempt", () => {
  it.fails("settles at or above everything it could have been billed", async () => {
    script = [
      // Call A (measured): first attempt dropped, retry succeeds with usage.
      dropped,
      async () => new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } }),
      // Call B (usage-less): all three attempts dropped.
      dropped,
      dropped,
      dropped,
    ];
    const c = mods.collector.createUsageCollector(AT);
    await mods.collector.withUsageCollector(c, async () => {
      await mods.dedup.isSameStory("candidate A", "existing A");
      await mods.dedup.isSameStory("candidate B", "existing B");
    });
    expect(sent).toHaveLength(5);
    const calls = c.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0].tokens).not.toBeNull();
    expect(calls[1].tokens).toBeNull();
    expect(calls[1].bound?.attempts).toBe(3);

    const summary = c.summarize();
    const ceiling = mods.usageRecord.settleCeilingFor(summary, { dedup: 2 });
    const settled = mods.spend.settleAmount(0.7, { totalBilledUsd: summary.totalBilledUsd, isFloor: true }, ceiling)!;

    // The most the provider could have billed: A's measured retry, A's dropped
    // first attempt at its worst case, and B's three dropped attempts.
    const possible = summary.totalBilledUsd + worstCaseOf(sent[0]) + worstCaseOf(sent[2]) + worstCaseOf(sent[3]) + worstCaseOf(sent[4]);
    console.log(JSON.stringify({ settled, possible, shortfall: possible - settled, reservation: 0.7 }));
    expect(settled).toBeLessThan(0.7);
    expect(settled).toBeGreaterThanOrEqual(possible - 1e-12);
  }, 20_000);
});
