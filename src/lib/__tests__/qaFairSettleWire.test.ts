import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { Cluster } from "@/types";

// QA (review-loop rounds 1-2, v2.4-fair-settle). Runs the REAL Anthropic SDK with
// a stubbed global fetch, so nothing leaves the machine, and checks the bound
// each call site records against the bytes the SDK actually puts on the wire,
// and how many HTTP attempts sit behind one recorded call.

const sent: { body: string; bytes: number }[] = [];
let respond: () => Promise<Response> = async () => new Response("{}", { status: 400 });

let mods: {
  collector: typeof import("@/lib/usageCollector");
  usage: typeof import("@/lib/usage");
  usageRecord: typeof import("@/lib/usageRecord");
  spend: typeof import("@/lib/spend");
  writeCard: typeof import("@/lib/writeCard");
  cards: typeof import("@/lib/cards");
  dedup: typeof import("@/lib/dedup");
  rank: typeof import("@/lib/rank");
  triage: typeof import("@/lib/triage");
};

beforeAll(async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "qa-not-a-real-key");
  vi.stubEnv("ANTHROPIC_BASE_URL", "http://qa.invalid");
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const body = typeof init.body === "string" ? init.body : "";
    sent.push({ body, bytes: Buffer.byteLength(body, "utf8") });
    return respond();
  });
  vi.resetModules();
  mods = {
    collector: await import("@/lib/usageCollector"),
    usage: await import("@/lib/usage"),
    usageRecord: await import("@/lib/usageRecord"),
    spend: await import("@/lib/spend"),
    writeCard: await import("@/lib/writeCard"),
    cards: await import("@/lib/cards"),
    dedup: await import("@/lib/dedup"),
    rank: await import("@/lib/rank"),
    triage: await import("@/lib/triage"),
  };
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  sent.length = 0;
  respond = async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "qa" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
});

const AT = new Date("2026-10-03T12:00:00Z");

function cluster(sources: number, text = "Snippet text about the story."): Cluster {
  return {
    topic: "Tech/AI",
    articles: Array.from({ length: sources }, (_, i) => ({
      title: `Title ${i} — “quoted” المغرب`,
      snippet: `${text} ${i}`,
      url: `https://example.com/${i}`,
      source: i % 2 === 0 ? "BBC" : "Reuters",
      topic: "Tech/AI",
      publishedAt: "2026-10-03T10:00:00Z",
    })),
  } as Cluster;
}

async function runCapturing(fn: () => Promise<unknown>) {
  const c = mods.collector.createUsageCollector(AT);
  await mods.collector.withUsageCollector(c, () => fn().catch(() => undefined));
  return c;
}

describe("the recorded bound covers the bytes the SDK actually sends", () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["writeCard (Haiku)", () => mods.writeCard.writeCard(cluster(1), 3)],
    ["writeCard (Sonnet, thinking disabled)", () => mods.writeCard.writeCard(cluster(4), 3, ["BBC"] as never)],
    [
      "expand",
      () =>
        mods.cards.generateExpandedReport({
          topic: "Tech/AI",
          shortSummary: "A short “summary”.",
          sources: [{ title: "T", url: "https://e.com", source: "BBC", snippet: "S المغرب" }],
        } as never),
    ],
    ["dedup", () => mods.dedup.isSameStory("candidate “text”", "existing summary")],
    ["rank", () => mods.rank.rankFrontPage([{ topic: "Tech/AI", severity: 3, text: "a" }, { topic: "Tech/AI", severity: 2, text: "b" }] as never)],
    ["triage", () => mods.triage.triageClusters([cluster(1), cluster(2)])],
  ];

  it.each(cases)("%s", async (_label, fn) => {
    const c = await runCapturing(fn);
    const calls = c.calls();
    expect(calls.length).toBeGreaterThan(0);
    // 400 is not retried by the SDK, so one recorded call per HTTP request.
    expect(sent.length).toBe(calls.length);
    calls.forEach((call, i) => {
      expect(call.tokens).toBeNull();
      expect(call.bound).toBeDefined();
      // The bound must be at least the request the server received.
      expect(call.bound!.requestBytes).toBeGreaterThanOrEqual(sent[i].bytes);
      const body = JSON.parse(sent[i].body);
      expect(call.bound!.maxOutputTokens).toBe(body.max_tokens);
      // Nothing the SDK sends is outside what boundOf measured: the wire body
      // is exactly JSON.stringify(params) minus functions.
      expect(call.bound!.requestBytes).toBe(sent[i].bytes);
      // The module-scope client is the SDK default: two retries, three attempts.
      expect(call.bound!.attempts).toBe(3);
    });
    // And with every call bounded and priced, the run gets a finite ceiling.
    const summary = c.summarize();
    const expected = Object.fromEntries(
      [...new Set(calls.map((x) => x.stage))].map((s) => [s, calls.filter((x) => x.stage === s).length])
    );
    expect(mods.usageRecord.settleCeilingFor(summary, expected)).not.toBeNull();
  });

  it("triage with reasons on records the larger output limit it actually sends", async () => {
    vi.stubEnv("TRIAGE_REASONS", "1");
    try {
      const c = await runCapturing(() => mods.triage.triageClusters([cluster(1)]));
      expect(sent.length).toBe(c.calls().length);
      c.calls().forEach((call, i) => {
        expect(JSON.parse(sent[i].body).max_tokens).toBe(2048);
        expect(call.bound!.maxOutputTokens).toBe(2048);
        expect(call.bound!.requestBytes).toBe(sent[i].bytes);
      });
    } finally {
      vi.stubEnv("TRIAGE_REASONS", "");
    }
  });

  it("Sonnet writeCard sends thinking disabled; Haiku sends no thinking key at all", async () => {
    await runCapturing(() => mods.writeCard.writeCard(cluster(4), 3));
    const sonnet = JSON.parse(sent[0].body);
    expect(sonnet.model).toBe("claude-sonnet-5");
    expect(sonnet.thinking).toEqual({ type: "disabled" });
    expect(sonnet.output_config.format.type).toBe("json_schema");
    expect(sonnet.output_config.format.parse).toBeUndefined();
    sent.length = 0;
    await runCapturing(() => mods.writeCard.writeCard(cluster(1), 3));
    const haiku = JSON.parse(sent[0].body);
    expect(haiku.model).toBe("claude-haiku-4-5");
    expect("thinking" in haiku).toBe(false);
  });
});

/** The most one HTTP request with this wire body could have been billed, priced independently of addBoundCost. */
function worstCaseOf(body: string, model: "claude-haiku-4-5" | "claude-sonnet-5" = "claude-haiku-4-5"): number {
  const parsed = JSON.parse(body);
  const cost = mods.usage.costFor(
    model,
    {
      inputTokens: Buffer.byteLength(body, "utf8") + mods.usage.REQUEST_OVERHEAD_TOKENS,
      outputTokens: parsed.max_tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    AT
  );
  return Math.max(cost.billedUsd, cost.listUsd);
}

/** What the routes settle a run to, computed the way they compute it. */
function settleOf(c: ReturnType<typeof mods.collector.createUsageCollector>, expected: Record<string, number>, reservedUsd: number) {
  const summary = c.summarize();
  const ceiling = mods.usageRecord.settleCeilingFor(summary, expected);
  const isFloor = summary.totalCallsWithoutUsage > 0;
  return { ceiling, settled: mods.spend.settleAmount(reservedUsd, { totalBilledUsd: summary.totalBilledUsd, isFloor }, ceiling) };
}

describe("SDK-level retries behind one recordCall are covered by the ceiling", () => {
  it("a retried 500: three HTTP requests, one recorded call whose bound carries all three attempts", async () => {
    respond = async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "qa" } }), {
        status: 500,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    const c = await runCapturing(() => mods.dedup.isSameStory("candidate", "existing"));
    expect(sent.length).toBe(3);
    expect(c.calls()).toHaveLength(1);
    expect(c.calls()[0].bound?.attempts).toBe(sent.length);
    const possible = sent.reduce((sum, s) => sum + worstCaseOf(s.body), 0);
    const { ceiling, settled } = settleOf(c, { dedup: 1 }, 0.7);
    expect(ceiling).not.toBeNull();
    expect(ceiling!).toBeGreaterThanOrEqual(possible - 1e-12);
    expect(settled!).toBeGreaterThanOrEqual(possible - 1e-12);
    // And the fair path is the one taken: below the hold.
    expect(settled!).toBeLessThan(0.7);
  });

  it("a connection failure (the case a server may already have billed) on all three attempts settles at or above all three worst cases", async () => {
    respond = async () => {
      throw new TypeError("fetch failed: socket hang up");
    };
    const c = await runCapturing(() => mods.dedup.isSameStory("candidate", "existing"));
    expect(sent.length).toBe(3);
    const calls = c.calls();
    expect(calls).toHaveLength(1);
    // Each attempt is byte-identical, so the recorded bytes cover every one.
    for (const s of sent) expect(calls[0].bound!.requestBytes).toBeGreaterThanOrEqual(s.bytes);
    const possible = sent.reduce((sum, s) => sum + worstCaseOf(s.body), 0);
    const { ceiling, settled } = settleOf(c, { dedup: 1 }, 0.7);
    expect(ceiling!).toBeCloseTo(possible, 12);
    expect(settled!).toBeGreaterThanOrEqual(possible - 1e-12);
    expect(settled!).toBeLessThan(0.7);
  }, 15_000);

  it("a Sonnet writeCard failing three times on the wire settles at or above three Sonnet worst cases", async () => {
    respond = async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "qa" } }), {
        status: 529,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    const c = await runCapturing(() => mods.writeCard.writeCard(cluster(4), 3));
    expect(sent.length).toBe(3);
    expect(JSON.parse(sent[0].body).model).toBe("claude-sonnet-5");
    const possible = sent.reduce((sum, s) => sum + worstCaseOf(s.body, "claude-sonnet-5"), 0);
    const { settled } = settleOf(c, { writeCard: 1 }, 5);
    expect(settled!).toBeGreaterThanOrEqual(possible - 1e-12);
  });
});
