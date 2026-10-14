import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// QA (review round 2, Haiku 5.5 switch): callModel's per-call parse state
// under Promise.all fan-out, and the wire max_tokens of every step, through
// the REAL Anthropic SDK with only global fetch replaced. Replies arrive in a
// shuffled order, so a parse error or a refusal leaking between concurrent
// calls would land on the wrong one. No network, no paid call.

type Reply = { content: unknown[]; stop_reason: string; stop_details?: unknown; usage?: unknown };

const net = vi.hoisted(() => {
  const saved = { fetch: globalThis.fetch, key: process.env.ANTHROPIC_API_KEY };
  process.env.ANTHROPIC_API_KEY = "qa-not-a-real-key";
  const state = {
    bodies: [] as string[],
    route: ((): Reply => ({ content: [], stop_reason: "end_turn" })) as (body: Record<string, unknown>) => Reply,
    jitter: true,
  };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    state.bodies.push(raw);
    const reply = state.route(JSON.parse(raw) as Record<string, unknown>);
    // Out-of-order completion: later requests often finish first.
    if (state.jitter) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15)));
    return new Response(
      JSON.stringify({ id: "msg_qa", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 5 }, ...reply }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return { state, saved };
});

vi.mock("@/lib/embeddings", () => ({
  embed: async (texts: string[]) => texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
  cosineSimilarity: () => 0.99,
}));
vi.mock("@/lib/extract", async (orig) => {
  const blocked = async (urls: readonly string[]) => urls.map((url) => ({ url, ok: false as const, reason: "robots" as const }));
  return { ...(await orig<typeof import("@/lib/extract")>()), extractArticles: blocked, extractForStory: blocked };
});

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicError } from "@anthropic-ai/sdk/error";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODELS, RefusalError, callModel, requestFor } from "@/lib/models";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import { triageClusters } from "@/lib/triage";
import { linkStories } from "@/lib/storyTimeline";
import { isSameStory } from "@/lib/dedup";
import { rankFrontPage } from "@/lib/rank";
import { mergeDuplicateClusters } from "@/lib/mergeDuplicates";
import { writeCard } from "@/lib/writeCard";
import { generateExpandedReport } from "@/lib/cards";
import { FAIL_CLOSED } from "@/lib/triageOutcome";
import { TOPICS, type Cluster, type Topic } from "@/types";

const AT = new Date("2026-10-13T12:00:00Z");
const userText = (body: Record<string, unknown>) => String((body.messages as { content: string }[])[0].content);

function lines(): string[] {
  return (["log", "warn", "error"] as const)
    .flatMap((level) => vi.mocked(console[level]).mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
}

beforeEach(() => {
  net.state.bodies = [];
  net.state.jitter = true;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  globalThis.fetch = net.saved.fetch;
  if (net.saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = net.saved.key;
});

describe("callModel: 90 concurrent calls, three outcomes interleaved, nothing crosses between calls", () => {
  it("each call gets its own parsed value, its own refusal category, its own parse error", async () => {
    const client = new Anthropic({ maxRetries: 0 });
    const schema = z.object({ id: z.number() });
    net.state.route = (body) => {
      const id = Number(/id=(\d+)/.exec(userText(body))?.[1]);
      if (id % 3 === 0) {
        return { content: [{ type: "text", text: '{"id":' }], stop_reason: "refusal", stop_details: { type: "refusal", category: `cat_${id}` } };
      }
      if (id % 3 === 1) return { content: [{ type: "text", text: '{"id":"not a number"}' }], stop_reason: "end_turn" };
      return { content: [{ type: "text", text: JSON.stringify({ id }) }], stop_reason: "end_turn" };
    };
    const usage = createUsageCollector(AT);
    const ids = Array.from({ length: 90 }, (_, i) => i);
    // One shared format object for every call, which is the worst case for
    // shared state: the tolerant wrapper must be per call, not per format.
    const format = zodOutputFormat(schema);
    const results = await withUsageCollector(usage, () =>
      Promise.allSettled(
        ids.map((id) =>
          callModel(
            client,
            "triage",
            requestFor("claude-haiku-5-5", { max_tokens: 64, messages: [{ role: "user", content: `id=${id}` }], output_config: { format } })
          )
        )
      )
    );
    results.forEach((r, id) => {
      if (id % 3 === 0) {
        expect(r.status).toBe("rejected");
        const err = (r as PromiseRejectedResult).reason;
        expect(err).toBeInstanceOf(RefusalError);
        expect((err as RefusalError).category).toBe(`cat_${id}`);
      } else if (id % 3 === 1) {
        expect(r.status).toBe("rejected");
        const err = (r as PromiseRejectedResult).reason;
        expect(err).toBeInstanceOf(AnthropicError);
        expect(err).not.toBeInstanceOf(RefusalError);
        expect(String((err as Error).message)).toMatch(/^Failed to parse structured output: /);
      } else {
        expect(r.status).toBe("fulfilled");
        expect((r as PromiseFulfilledResult<{ parsed_output: { id: number } }>).value.parsed_output).toEqual({ id });
      }
    });
    const calls = usage.calls();
    expect(calls).toHaveLength(90);
    // Refused and valid calls keep their usage; only the 30 parse failures lose it.
    expect(calls.filter((c) => c.tokens === null)).toHaveLength(30);
    expect(calls.every((c) => c.model === "claude-haiku-5-5")).toBe(true);
  });
});

function clusterIn(topic: Topic, tag: string): Cluster {
  return {
    topic,
    articles: [{ title: `Headline ${tag}`, snippet: "Snippet", url: `https://example.com/${tag}`, source: "BBC", topic, publishedAt: "2026-10-13T12:00:00Z" }],
  } as Cluster;
}

describe("triage batches in parallel: one topic refuses, one returns broken JSON, one answers", () => {
  it("each batch fails or succeeds on its own, and the logs name the right topic", async () => {
    const [refuse, broken, good] = TOPICS.slice(0, 3) as Topic[];
    net.state.route = (body) => {
      const text = userText(body);
      const count = (text.match(/^\d+\. /gm) ?? []).length;
      if (text.startsWith(`Topic: ${refuse}\n`)) {
        return { content: [{ type: "text", text: '{"verdicts":[{"ind' }], stop_reason: "refusal", stop_details: { type: "refusal", category: "qa_refuse" } };
      }
      if (text.startsWith(`Topic: ${broken}\n`)) return { content: [{ type: "text", text: '{"verdicts":[' }], stop_reason: "max_tokens" };
      const verdicts = Array.from({ length: count }, (_, index) => ({ index, notable: true, severity: 4, event: `Event ${index}` }));
      return { content: [{ type: "text", text: JSON.stringify({ verdicts }) }], stop_reason: "end_turn" };
    };
    const clusters: Cluster[] = [];
    for (let i = 0; i < 4; i++) clusters.push(clusterIn(refuse, `r${i}`), clusterIn(broken, `b${i}`), clusterIn(good, `g${i}`));
    const usage = createUsageCollector(AT);
    const out = await withUsageCollector(usage, () => triageClusters(clusters));
    clusters.forEach((c, i) => {
      if (c.topic === good) expect(out[i]).toMatchObject({ notable: true, severity: 4 });
      else expect(out[i]).toEqual(FAIL_CLOSED);
    });
    const refusalLines = lines().filter((l) => l.includes("refused by the model"));
    const parseLines = lines().filter((l) => l.includes("Failed to parse structured output"));
    // Every request for the refusing topic logs its refusal; none other does.
    const refuseRequests = net.state.bodies.filter((b) => userText(JSON.parse(b)).startsWith(`Topic: ${refuse}\n`)).length;
    const brokenRequests = net.state.bodies.filter((b) => userText(JSON.parse(b)).startsWith(`Topic: ${broken}\n`)).length;
    expect(refuseRequests).toBeGreaterThan(1); // the ladder ran
    expect(refusalLines).toHaveLength(refuseRequests);
    expect(refusalLines.every((l) => l.includes(`for ${refuse} failed`) && l.includes("(category: qa_refuse)"))).toBe(true);
    expect(parseLines).toHaveLength(brokenRequests);
    expect(parseLines.every((l) => l.includes(`for ${broken} failed`))).toBe(true);
    // Usage: the refusing topic's requests are all measured.
    const measured = usage.calls().filter((c) => c.tokens !== null).length;
    expect(measured).toBe(net.state.bodies.length - brokenRequests);
  });
});

describe("timeline workers: 40 cards checked 16 at a time, odd ones refused", () => {
  it("each card gets its own outcome and the refusal warn line is once per refused card", async () => {
    net.state.route = (body) => {
      const n = Number(/New card \(2026-10-13\): Card (\d+)\./.exec(userText(body))?.[1]);
      if (n % 2 === 1) return { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: `tl_${n}` } };
      return { content: [{ type: "text", text: '{"match":1}' }], stop_reason: "end_turn" };
    };
    const cards = Array.from({ length: 40 }, (_, n) => ({ id: `card-${n}`, title: `Card ${n}`, shortSummary: "S" }));
    const earlier = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        storyId: "22222222-2222-4222-8222-222222222222",
        date: "2026-10-10",
        title: "E",
        shortSummary: "ES",
        embedding: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
      },
    ];
    const r = await linkStories(cards, "2026-10-13", earlier);
    expect(r.haikuCalls).toBe(40);
    expect(r.linked).toBe(20);
    for (let n = 0; n < 40; n++) {
      expect(r.links.get(`card-${n}`)?.storyId).toBe(n % 2 ? `card-${n}` : "22222222-2222-4222-8222-222222222222");
    }
    const warn = lines().filter((l) => l.startsWith("[timeline]") && l.includes("refused by the model"));
    expect(warn).toHaveLength(20);
    for (let n = 1; n < 40; n += 2) expect(warn.filter((l) => l.includes(`(category: tl_${n})`))).toHaveLength(1);
    expect(lines().some((l) => /story check\(s\) failed/.test(l))).toBe(false);
  });
});

describe("the wire max_tokens of every step is its pre-switch cap, plus 1024 on Haiku 5.5", () => {
  // The caps each step sent before the switch, typed here rather than read
  // from the source, so a changed constant or a dropped bump both go red.
  const PRE_SWITCH_CAP = {
    triage: 2048,
    dedup: 256,
    merge: 1024,
    rank: 1024,
    timeline: 32,
    writeCardSingle: 2048,
    writeCardMulti: 2048,
    expand: 4096,
  } as const;
  const VALID = {
    triage: '{"verdicts":[{"index":0,"notable":true,"severity":5,"event":"An event happened"}]}',
    dedup: '{"sameStory":true}',
    merge: '{"verdicts":[{"pair":0,"same":true}]}',
    rank: '{"picks":[{"index":0,"rank":1}]}',
    timeline: '{"match":1}',
    writeCardSingle: '{"title":"T","shortSummary":"A complete sentence.","labels":["Tag"]}',
    writeCardMulti: '{"title":"T","shortSummary":"A complete sentence.","labels":["Tag"]}',
    expand: '{"report":"A complete report."}',
  } as const;
  type Step = keyof typeof PRE_SWITCH_CAP;
  const c = (n: number, tag: string) =>
    ({
      topic: "Tech/AI",
      articles: Array.from({ length: n }, (_, i) => ({ title: `T ${tag}${i}`, snippet: "S", url: `https://example.com/${tag}${i}`, source: i % 2 ? "Reuters" : "BBC", topic: "Tech/AI", publishedAt: "2026-10-13T12:00:00Z" })),
    }) as Cluster;
  const run: Record<Step, () => Promise<unknown>> = {
    triage: () => triageClusters([c(1, "t")]),
    dedup: () => isSameStory("a", "b"),
    merge: () =>
      mergeDuplicateClusters(
        [
          { cluster: c(1, "a"), notable: true, severity: 4, event: "Event one" },
          { cluster: c(1, "b"), notable: true, severity: 4, event: "Event two" },
        ],
        []
      ),
    rank: () => rankFrontPage([{ topic: "Tech/AI", severity: 4, text: "x" }]),
    timeline: () =>
      linkStories([{ id: "n", title: "T", shortSummary: "S" }], "2026-10-13", [
        { id: "11111111-1111-4111-8111-111111111111", storyId: null, date: "2026-10-10", title: "E", shortSummary: "ES", embedding: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)) },
      ]),
    writeCardSingle: () => writeCard(c(1, "w"), 4),
    writeCardMulti: () => writeCard(c(3, "m"), 4),
    expand: () => generateExpandedReport({ topic: "Tech/AI", shortSummary: "S.", sources: [{ title: "T", url: "https://e.com/a", source: "BBC", snippet: "s" }] }),
  };
  it.each(Object.keys(PRE_SWITCH_CAP) as Step[])("%s", async (step) => {
    net.state.jitter = false;
    net.state.route = () => ({ content: [{ type: "text", text: VALID[step] }], stop_reason: "end_turn" });
    await run[step]();
    expect(net.state.bodies.length).toBeGreaterThanOrEqual(1);
    const expected = PRE_SWITCH_CAP[step] + (MODELS[step] === "claude-haiku-5-5" ? 1024 : 0);
    for (const raw of net.state.bodies) expect((JSON.parse(raw) as { max_tokens: number }).max_tokens).toBe(expected);
  });
});
