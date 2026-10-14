import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// QA (review round 1, Haiku 5.5 switch): every call site through the REAL
// Anthropic SDK, with only global fetch replaced, so `messages.parse`, the
// zod output format and callModel's tolerant parser all run for real. No
// network and no paid call: the fake fetch answers every request itself.

const net = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "qa-not-a-real-key";
  const state = {
    bodies: [] as string[],
    /** Builds the JSON message the fake API answers with. */
    reply: (() => ({})) as () => Record<string, unknown>,
  };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    state.bodies.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({
        id: "msg_qa",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        stop_sequence: null,
        ...state.reply(),
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return { state };
});

vi.mock("@/lib/embeddings", () => ({
  embed: async (texts: string[]) => texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
  cosineSimilarity: () => 0.99,
}));
vi.mock("@/lib/extract", async (orig) => {
  const blocked = async (urls: readonly string[]) =>
    urls.map((url) => ({ url, ok: false as const, reason: "robots" as const }));
  return { ...(await orig<typeof import("@/lib/extract")>()), extractArticles: blocked, extractForStory: blocked };
});

import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import { GenerationRejectedError } from "@/lib/claudeText";
import { classifyCardFailure } from "@/lib/cardFailure";
import { FAIL_CLOSED } from "@/lib/triageOutcome";
import { MODELS } from "@/lib/models";
import { triageClusters } from "@/lib/triage";
import { isSameStory } from "@/lib/dedup";
import { rankFrontPage } from "@/lib/rank";
import { mergeDuplicateClusters } from "@/lib/mergeDuplicates";
import { linkStories } from "@/lib/storyTimeline";
import { writeCard } from "@/lib/writeCard";
import { generateExpandedReport } from "@/lib/cards";
import type { Cluster } from "@/types";

const USAGE = { input_tokens: 777, output_tokens: 5 };
const AT = new Date("2026-10-13T12:00:00Z");

function cluster(n: number, tag = ""): Cluster {
  return {
    topic: "Tech/AI",
    articles: Array.from({ length: n }, (_, i) => ({
      title: `Title ${tag}${i}`,
      snippet: "Snippet",
      url: `https://example.com/${tag}${i}`,
      source: i % 2 ? "Reuters" : "BBC",
      topic: "Tech/AI",
      publishedAt: "2026-07-31T12:00:00Z",
    })),
  } as Cluster;
}

type StepName = "triage" | "dedup" | "merge" | "rank" | "timeline" | "writeCardSingle" | "writeCardMulti" | "expand";

/** A valid answer per step, so a site acting on parsed_output past a refusal would show it. */
const VALID: Record<StepName, string> = {
  triage: '{"verdicts":[{"index":0,"notable":true,"severity":5,"event":"An event happened"}]}',
  dedup: '{"sameStory":true}',
  merge: '{"verdicts":[{"pair":0,"same":true}]}',
  rank: '{"picks":[{"index":0,"rank":1}]}',
  timeline: '{"match":1}',
  writeCardSingle: '{"title":"T","shortSummary":"A complete sentence.","labels":["Tag"]}',
  writeCardMulti: '{"title":"T","shortSummary":"A complete sentence.","labels":["Tag"]}',
  expand: '{"report":"A complete report."}',
};

/** Runs one step and returns its outcome (resolved value or thrown error). */
async function runStep(step: StepName): Promise<unknown> {
  const item = (e: string, tag: string) => ({ cluster: cluster(1, tag), notable: true, severity: 4, event: e });
  switch (step) {
    case "triage":
      return triageClusters([cluster(1)]);
    case "dedup":
      return isSameStory("a candidate", "an existing summary");
    case "rank":
      return rankFrontPage([{ topic: "Tech/AI", severity: 4, text: "a summary" }]);
    case "merge":
      return mergeDuplicateClusters([item("Event one", "a"), item("Event two", "b")], []);
    case "timeline":
      return linkStories([{ id: "new-card", title: "T", shortSummary: "S" }], "2026-10-13", [
        {
          id: "11111111-1111-4111-8111-111111111111",
          storyId: "22222222-2222-4222-8222-222222222222",
          date: "2026-10-10",
          title: "E",
          shortSummary: "ES",
          embedding: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
        },
      ]);
    case "writeCardSingle":
      return writeCard(cluster(1), 4).catch((e: unknown) => e);
    case "writeCardMulti":
      return writeCard(cluster(3), 4).catch((e: unknown) => e);
    case "expand":
      return generateExpandedReport({
        topic: "Tech/AI",
        shortSummary: "S.",
        sources: [{ title: "T", url: "https://e.com/a", source: "BBC", snippet: "s" }],
      }).catch((e: unknown) => e);
  }
}

const STEPS: StepName[] = ["triage", "dedup", "merge", "rank", "timeline", "writeCardSingle", "writeCardMulti", "expand"];

function allLines(): string[] {
  return (["log", "warn", "error"] as const)
    .flatMap((level) => vi.mocked(console[level]).mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
}

beforeEach(() => {
  net.state.bodies = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type Variant = { name: string; content: (step: StepName) => unknown[] };
const VARIANTS: Variant[] = [
  { name: "partial JSON text", content: (s) => [{ type: "text", text: VALID[s].slice(0, 9) }] },
  { name: "empty content", content: () => [] },
  { name: "a complete, valid answer", content: (s) => [{ type: "text", text: VALID[s] }] },
  {
    name: "a leading thinking block then partial text",
    content: (s) => [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: VALID[s].slice(0, 5) },
    ],
  },
];

describe.each(VARIANTS)("refusal with $name, through the real SDK", ({ content }) => {
  it.each(STEPS)("%s: takes its failure path, keeps usage, logs the category once per call", async (step) => {
    const category = `qa_cat_${step}`;
    net.state.reply = () => ({
      content: content(step),
      stop_reason: "refusal",
      stop_details: { type: "refusal", category, explanation: null },
      usage: USAGE,
    });
    const usage = createUsageCollector(AT);
    const outcome = await withUsageCollector(usage, () => runStep(step));
    const requests = net.state.bodies.length;

    switch (step) {
      case "triage":
        expect(outcome).toEqual([FAIL_CLOSED]);
        expect(requests).toBe(3); // whole batch, then the split-retry ladder
        break;
      case "dedup":
        expect(outcome).toBe(false);
        expect(requests).toBe(1);
        break;
      case "merge":
        expect(outcome).toMatchObject({ merged: 0, haikuCalls: 1 });
        expect((outcome as { items: unknown[] }).items).toHaveLength(2);
        expect(requests).toBe(1);
        break;
      case "rank":
        expect(outcome).toBeNull();
        expect(requests).toBe(1);
        break;
      case "timeline": {
        const r = outcome as { links: Map<string, { storyId: string }>; haikuCalls: number; linked: number };
        expect(r.links.get("new-card")?.storyId).toBe("new-card");
        expect(r).toMatchObject({ haikuCalls: 1, linked: 0 });
        expect(requests).toBe(1);
        // Not counted with the failures.
        expect(allLines().some((l) => /story check\(s\) failed/.test(l))).toBe(false);
        expect(allLines().filter((l) => l.startsWith("[timeline]") && l.includes("refused by the model"))).toHaveLength(1);
        break;
      }
      case "writeCardSingle":
      case "writeCardMulti": {
        expect(outcome).toBeInstanceOf(GenerationRejectedError);
        const sources = step === "writeCardSingle" ? 1 : 3;
        expect(classifyCardFailure(outcome, MODELS[step], sources)).toMatchObject({ reason: "empty", stopReason: "refusal" });
        expect(requests).toBe(1); // never retried
        break;
      }
      case "expand":
        expect(outcome).toBeInstanceOf(GenerationRejectedError);
        expect((outcome as GenerationRejectedError).reason).toBe("empty");
        expect((outcome as GenerationRejectedError).stopReason).toBe("refusal");
        expect(requests).toBe(1);
        break;
    }

    // Usage: one record per request, every one with its real tokens.
    const calls = usage.calls();
    expect(calls).toHaveLength(requests);
    for (const c of calls) {
      expect(c.model).toBe(MODELS[step]);
      expect(c.tokens).toEqual({ inputTokens: 777, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
    }
    // The category, once per call.
    const categoryLines = allLines().filter((l) => l.includes(`(category: ${category})`));
    expect(categoryLines).toHaveLength(requests);
    // A refusal is never reported as a parse failure.
    expect(allLines().some((l) => l.includes("Failed to parse structured output"))).toBe(false);
  });
});

describe("refusal with no stop_details", () => {
  it.each(STEPS)("%s: names the missing category and still records usage", async (step) => {
    net.state.reply = () => ({ content: [], stop_reason: "refusal", usage: USAGE });
    const usage = createUsageCollector(AT);
    await withUsageCollector(usage, () => runStep(step));
    expect(allLines().filter((l) => l.includes("(category: none given)"))).toHaveLength(net.state.bodies.length);
    expect(usage.calls().every((c) => c.tokens !== null)).toBe(true);
  });
});

describe("the wire request of every step, on the model MODELS names", () => {
  it.each(STEPS)("%s: no sampling params, no prefill, no parse function, thinking off, effort low", async (step) => {
    net.state.reply = () => ({ content: [{ type: "text", text: VALID[step] }], stop_reason: "end_turn", usage: USAGE });
    await runStep(step);
    expect(net.state.bodies.length).toBeGreaterThanOrEqual(1);
    for (const raw of net.state.bodies) {
      const body = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ["temperature", "top_p", "top_k", "fallbacks"]) expect(key in body).toBe(false);
      expect(raw.includes('"parse"')).toBe(false);
      const messages = body.messages as { role: string }[];
      expect(messages.every((m) => m.role === "user")).toBe(true);
      // Follows the model map, so a reverted step still checks its own request.
      expect(body.model).toBe(MODELS[step]);
      const oc = body.output_config as { effort?: string; format: { type: string } };
      expect(oc.format.type).toBe("json_schema");
      if (MODELS[step] === "claude-haiku-5-5") {
        expect(body.thinking).toEqual({ type: "disabled" });
        expect(oc.effort).toBe("low");
      } else {
        expect("effort" in oc).toBe(false);
        expect(body.thinking).toEqual(MODELS[step] === "claude-sonnet-5" ? { type: "disabled" } : undefined);
      }
    }
  });

  it.each(STEPS)("%s: a usage-less call's bound bytes equal the bytes actually sent", async (step) => {
    // Unparseable, not refused: the call is recorded usage-less with its bound.
    net.state.reply = () => ({ content: [{ type: "text", text: '{"broken' }], stop_reason: "end_turn", usage: USAGE });
    const usage = createUsageCollector(AT);
    await withUsageCollector(usage, () => runStep(step));
    const calls = usage.calls();
    expect(calls.length).toBe(net.state.bodies.length);
    calls.forEach((c, i) => {
      expect(c.tokens).toBeNull();
      expect(c.bound?.requestBytes).toBe(Buffer.byteLength(net.state.bodies[i], "utf8"));
      expect(c.bound?.maxOutputTokens).toBe((JSON.parse(net.state.bodies[i]) as { max_tokens: number }).max_tokens);
    });
    // And the parse failure keeps the SDK's own wording somewhere on the failure path.
    expect(allLines().some((l) => l.includes("refused by the model"))).toBe(false);
  });
});
