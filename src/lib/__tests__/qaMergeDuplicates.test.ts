import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster, Source, Topic } from "@/types";
import type { ReadingUnit } from "@/lib/readingUnits";

// QA round 1: edge cases of mergeDuplicateClusters not covered by
// mergeDuplicates.test.ts. No real model, no real API: the SDK and the
// embedding module are mocked; each sentence's "vector" is the sentence itself
// and a table gives the score.

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  embed: vi.fn(),
  scores: new Map<string, number>(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mocks.parse }, maxRetries: 0 };
  }
  return { default: FakeAnthropic };
});

vi.mock("@/lib/embeddings", () => ({
  embed: mocks.embed,
  cosineSimilarity: (a: string[], b: string[]) => {
    // Touch the vector like the real one does, so a missing vector throws.
    void a.length;
    void b.length;
    return mocks.scores.get(`${a[0]}|${b[0]}`) ?? mocks.scores.get(`${b[0]}|${a[0]}`) ?? 0.2;
  },
}));

type Item = { cluster: Cluster; notable: boolean; severity: number; event?: string };

function item(event: string, opts: { topic?: Topic; severity?: number; urls?: string[]; sources?: Source[]; notable?: boolean } = {}): Item {
  const topic = opts.topic ?? ("Geopolitics" as Topic);
  const urls = opts.urls ?? [`https://example.com/${encodeURIComponent(event)}`];
  return {
    cluster: {
      topic,
      articles: urls.map((url, k) => ({
        title: `${event} headline ${k}`,
        snippet: "",
        url,
        source: (opts.sources?.[k] ?? "BBC") as Source,
        topic,
        publishedAt: "2026-10-03T08:00:00Z",
      })),
    },
    notable: opts.notable ?? true,
    severity: opts.severity ?? 3,
    event,
  };
}

/** Sentences of the pairs in the last call, read back from the prompt. */
function sentPairs(params: { messages: { content: string }[] }): [string, string][] {
  const out: [string, string][] = [];
  for (const block of params.messages[0].content.split(/\n\n(?=\d+\.\n)/)) {
    const a = /\nA: (.*)\n/.exec(block)?.[1];
    const b = /\nB: (.*)\n/.exec(block)?.[1];
    if (a && b) out.push([a, b]);
  }
  return out;
}

/** Haiku stand-in answering from a set of "same" sentence pairs. */
function haikuSame(same: Array<[string, string]>) {
  const key = (a: string, b: string) => [a, b].sort().join("|");
  const yes = new Set(same.map(([a, b]) => key(a, b)));
  mocks.parse.mockImplementation(async (params) => ({
    parsed_output: { verdicts: sentPairs(params).map(([a, b], pair) => ({ pair, same: yes.has(key(a, b)) })) },
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20 },
  }));
}

const UNITS: ReadingUnit[] = [{ topic: "Geopolitics", subtopic: null }];

async function merge(items: Item[], units = UNITS) {
  const { mergeDuplicateClusters } = await import("@/lib/mergeDuplicates");
  return mergeDuplicateClusters(items, units);
}

beforeEach(() => {
  mocks.parse.mockReset();
  mocks.embed.mockReset();
  mocks.scores.clear();
  mocks.embed.mockImplementation(async (texts: string[]) => texts.map((t) => [t]));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const A = "Russia struck Kyiv overnight with missiles and drones.";
const B = "Russia launched missile and drone strikes on Ukrainian cities overnight.";
const C = "Russia struck Lviv overnight with missiles and drones.";

describe("QA: failure paths never reject and count the call honestly", () => {
  beforeEach(() => {
    mocks.scores.set(`${A}|${C}`, 0.83);
  });

  it("a parse that throws synchronously counts as started (it was handed to recordCall) and merges nothing", async () => {
    mocks.parse.mockImplementation(() => {
      throw new Error("sync boom");
    });
    const items = [item(A), item(C)];

    const result = await merge(items);

    expect(result).toEqual({ items, merged: 0, haikuCalls: 1 });
  });

  it("parsed_output without a verdicts array merges nothing", async () => {
    mocks.parse.mockResolvedValue({ parsed_output: {}, stop_reason: "end_turn" });

    const result = await merge([item(A), item(C)]);

    expect(result.merged).toBe(0);
    expect(result.haikuCalls).toBe(1);
  });

  it("a verdict with same as a truthy non-boolean does not merge", async () => {
    mocks.parse.mockResolvedValue({ parsed_output: { verdicts: [{ pair: 0, same: "yes" }] } });

    const result = await merge([item(A), item(C)]);

    expect(result.merged).toBe(0);
  });

  it("embed returning fewer vectors than sentences: no call, nothing merged, no rejection", async () => {
    mocks.embed.mockImplementation(async (texts: string[]) => texts.slice(0, 1).map((t) => [t]));

    const result = await merge([item(A), item(C)]);

    expect(mocks.parse).not.toHaveBeenCalled();
    expect(result).toMatchObject({ merged: 0, haikuCalls: 0 });
  });

  it("a failed call while console.error also throws still resolves", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("closed stderr");
    });
    mocks.parse.mockRejectedValue(new Error("overloaded"));

    await expect(merge([item(A), item(C)])).resolves.toMatchObject({ merged: 0, haikuCalls: 1 });
  });

  it("a NaN score is never a candidate", async () => {
    mocks.scores.set(`${A}|${C}`, Number.NaN);

    const result = await merge([item(A), item(C)]);

    expect(mocks.parse).not.toHaveBeenCalled();
    expect(result.haikuCalls).toBe(0);
  });
});

describe("QA: merge correctness", () => {
  it("exactly at the threshold (0.55) is asked; just below is not", async () => {
    const { CANDIDATE_THRESHOLD } = await import("@/lib/mergeDuplicates");
    mocks.scores.set(`${A}|${C}`, CANDIDATE_THRESHOLD);
    haikuSame([]);
    await merge([item(A), item(C)]);
    expect(mocks.parse).toHaveBeenCalledTimes(1);

    mocks.parse.mockClear();
    mocks.scores.set(`${A}|${C}`, CANDIDATE_THRESHOLD - 1e-9);
    await merge([item(A), item(C)]);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("a real duplicate pushed past the 30-pair cap stays two cards", async () => {
    // 9 decoys scoring 0.9 against each other = 36 pairs above the dup's 0.6.
    const decoys = Array.from({ length: 9 }, (_, i) => `Decoy event ${i}.`);
    for (let i = 0; i < 9; i += 1) for (let j = i + 1; j < 9; j += 1) mocks.scores.set(`${decoys[i]}|${decoys[j]}`, 0.9);
    mocks.scores.set(`${A}|${C}`, 0.6);
    haikuSame([[A, C]]);

    const result = await merge([...decoys.map((d) => item(d)), item(A), item(C)]);

    expect(sentPairs(mocks.parse.mock.calls[0][0])).toHaveLength(30);
    expect(result.merged).toBe(0);
  });

  it("articles with an empty URL are never deduplicated against each other", async () => {
    mocks.scores.set(`${A}|${C}`, 0.8);
    haikuSame([[A, C]]);

    const result = await merge([item(A, { urls: [""] }), item(C, { urls: [""] })]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].cluster.articles).toHaveLength(2);
  });

  it("dedupes AMP and www variants of one URL across the group", async () => {
    mocks.scores.set(`${A}|${C}`, 0.8);
    haikuSame([[A, C]]);

    const result = await merge([
      item(A, { severity: 4, urls: ["https://www.bbc.com/news/x"] }),
      item(C, { urls: ["https://bbc.com/amp/news/x", "https://bbc.com/news/y"] }),
    ]);

    expect(result.items[0].cluster.articles.map((a) => a.url)).toEqual(["https://www.bbc.com/news/x", "https://bbc.com/news/y"]);
  });

  it("does not mutate the input items or their clusters", async () => {
    mocks.scores.set(`${A}|${C}`, 0.8);
    haikuSame([[A, C]]);
    const items = [item(A), item(C)];
    const snapshot = JSON.parse(JSON.stringify(items));

    await merge(items);

    expect(items).toEqual(snapshot);
  });

  it("is independent of the order Haiku returns its verdicts in", async () => {
    const D = "Russia struck Odesa port overnight.";
    mocks.scores.set(`${A}|${B}`, 0.8);
    mocks.scores.set(`${B}|${D}`, 0.7);
    mocks.scores.set(`${A}|${D}`, 0.6);
    const run = async (reverse: boolean) => {
      mocks.parse.mockImplementation(async (params) => {
        const verdicts = sentPairs(params).map((_, pair) => ({ pair, same: true }));
        return { parsed_output: { verdicts: reverse ? verdicts.reverse() : verdicts } };
      });
      return merge([item(D, { severity: 2 }), item(B, { severity: 3 }), item(A, { severity: 3 })]);
    };

    const first = await run(false);
    const second = await run(true);

    expect(second.items).toEqual(first.items);
    expect(first.items).toHaveLength(1);
    // Equal severity and article count: the earlier position (B) is kept.
    expect(first.items[0].event).toBe(B);
  });

  it("a chain never overrides Haiku's explicit 'different': A=B and B=C confirmed, A=C refused", async () => {
    // B is a vague umbrella sentence. Haiku: A=B yes, B=C yes, A=C NO.
    mocks.scores.set(`${A}|${C}`, 0.83);
    mocks.scores.set(`${A}|${B}`, 0.7);
    mocks.scores.set(`${B}|${C}`, 0.7);
    haikuSame([
      [A, B],
      [B, C],
    ]);

    const result = await merge([item(A), item(B), item(C)]);

    // A~B (0.7, earlier position) is applied; B~C would put C with A, which
    // Haiku called a different event, so it is skipped.
    expect(result.merged).toBe(1);
    expect(result.items).toHaveLength(2);
  });
});

describe("QA: union-find", () => {
  it("joins a cluster confirmed against two others that were not confirmed against each other (shared second member)", async () => {
    // Pairs (0,2) and (1,2) confirmed; (0,1) scores under the threshold, so
    // it was never asked and nothing refuses the chain: one event via C.
    mocks.scores.set(`${A}|${B}`, 0.5);
    mocks.scores.set(`${A}|${C}`, 0.8);
    mocks.scores.set(`${B}|${C}`, 0.7);
    haikuSame([
      [A, C],
      [B, C],
    ]);

    const result = await merge([item(A), item(B), item(C)]);

    expect(result.merged).toBe(2);
    expect(result.items).toHaveLength(1);
  });
});
