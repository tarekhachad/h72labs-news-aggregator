import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster, Source } from "@/types";
import type { ReadingUnit } from "@/lib/readingUnits";
import {
  BACKGROUND,
  MEASURED_SCORES,
  MUST_MERGE,
  MUST_NOT_MERGE,
  REWORDED_SAME_EVENT,
  SAME_PATTERN_DIFFERENT_EVENTS,
  sameEvent,
  type FixtureCluster,
} from "./fixtures/duplicateEvents";

// The duplicate check, on the evidence groups from a real digest. No test here
// loads the embedding model or calls the API:
//
// - embed() returns each sentence's fixture id, and cosineSimilarity() reads
//   the score measured for that pair with the real model (MEASURED_SCORES);
//   any pair not measured above 0.40 scores 0.30.
// - Haiku is a stand-in that answers each pair by Tarek's rule, using the
//   fixtures' ground truth. The real model's answers can't be tested without
//   paying for a call; what is tested is that the rule is in the prompt, that
//   only Haiku's "same" ever merges, and that every other path merges nothing.

const mocks = vi.hoisted(() => ({ parse: vi.fn(), embed: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mocks.parse }, maxRetries: 0 };
  }
  return { default: FakeAnthropic };
});

vi.mock("@/lib/embeddings", () => ({
  embed: mocks.embed,
  cosineSimilarity: (a: number[], b: number[]) => scoreOf(idByVector[a[0]], idByVector[b[0]]),
}));

const idByVector: string[] = [];
const idBySentence = new Map<string, string>();

function scoreOf(a: string, b: string): number {
  return MEASURED_SCORES[`${a}|${b}`] ?? MEASURED_SCORES[`${b}|${a}`] ?? 0.3;
}

type Item = { cluster: Cluster; notable: boolean; severity: number; triageSeverity?: number; event?: string; id: string };

function item(f: FixtureCluster, overrides: Partial<Item> = {}, articleCount = 1): Item {
  idBySentence.set(f.event, f.id);
  return {
    id: f.id,
    cluster: {
      topic: f.topic,
      ...(f.subtopic ? { subtopic: f.subtopic } : {}),
      articles: Array.from({ length: articleCount }, (_, k) => ({
        title: `${f.id} headline ${k}`,
        snippet: "",
        url: `https://example.com/${f.id}/${k}`,
        source: f.source as Source,
        topic: f.topic,
        ...(f.subtopic ? { subtopic: f.subtopic } : {}),
        publishedAt: "2026-10-03T08:00:00Z",
      })),
    },
    notable: true,
    severity: 3,
    event: f.event,
    ...overrides,
  };
}

/** The pairs sent in the last call, as [idA, idB], read back from the prompt. */
function sentPairs(call: unknown[] | undefined = mocks.parse.mock.calls.at(-1)): [string, string][] {
  const content = (call![0] as { messages: { content: string }[] }).messages[0].content;
  const pairs: [string, string][] = [];
  for (const block of content.split(/\n\n(?=\d+\.\n)/)) {
    const a = /\nA: (.*)\n/.exec(block)?.[1];
    const b = /\nB: (.*)\n/.exec(block)?.[1];
    if (a && b) pairs.push([idBySentence.get(a)!, idBySentence.get(b)!]);
  }
  return pairs;
}

/** Haiku stand-in: "same" exactly when the fixtures say it is one event. */
function haikuAnswersByRule() {
  mocks.parse.mockImplementation(async (params) => {
    const pairs = sentPairs([params]);
    return {
      parsed_output: { verdicts: pairs.map(([a, b], pair) => ({ pair, same: sameEvent(a, b) })) },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    };
  });
}

const UNITS: ReadingUnit[] = [
  { topic: "Football", subtopic: null },
  { topic: "Geopolitics", subtopic: null },
  { topic: "Defense & Security", subtopic: null },
  { topic: "Countries", subtopic: "Morocco" },
  { topic: "Countries", subtopic: "France" },
  { topic: "French Politics", subtopic: null },
  { topic: "Education", subtopic: null },
];

const ids = (items: { id: string }[]) => items.map((i) => i.id);

beforeEach(() => {
  mocks.parse.mockReset();
  mocks.embed.mockReset();
  idByVector.length = 0;
  idBySentence.clear();
  mocks.embed.mockImplementation(async (texts: string[]) =>
    texts.map((t) => {
      idByVector.push(idBySentence.get(t) ?? t);
      return [idByVector.length - 1];
    }),
  );
  haikuAnswersByRule();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function merge(items: Item[], units = UNITS) {
  const { mergeDuplicateClusters } = await import("@/lib/mergeDuplicates");
  return mergeDuplicateClusters(items, units);
}

describe("the evidence day", () => {
  const day = () => [
    ...MUST_MERGE.flat().map((f) => item(f)),
    ...MUST_NOT_MERGE.flat().map((f) => item(f)),
    ...BACKGROUND.map((f) => item(f)),
  ];

  it("merges every must-merge group into one cluster citing every outlet, and nothing else", async () => {
    const result = await merge(day());

    expect(result.merged).toBe(5);
    expect(result.haikuCalls).toBe(1);
    const sources = (id: string) => result.items.find((i) => i.id === id)!.cluster.articles.map((a) => a.source);
    expect(ids(result.items)).toEqual(
      ids(day()).filter((id) => !["england-espn-b", "schools-figaro", "schools-npr", "kyiv-france24", "coalition-ledesk-b"].includes(id)),
    );
    expect(sources("england-espn-a")).toEqual(["ESPN", "ESPN"]);
    expect(sources("schools-bfm")).toEqual(["BFM TV", "Le Figaro", "NPR"]);
    expect(sources("kyiv-guardian")).toEqual(["The Guardian", "France24"]);
    expect(sources("coalition-ledesk-a")).toEqual(["Le Desk", "Le Desk"]);
  });

  it("keeps both of Tarek's related-angle pairs separate", async () => {
    const result = await merge(day());

    for (const [a, b] of MUST_NOT_MERGE) {
      expect(ids(result.items)).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(result.items.find((i) => i.id === a.id)!.cluster.articles).toHaveLength(1);
    }
  });

  it("asks about exactly the pairs at or above 0.55, highest first, in one call", async () => {
    await merge(day());

    expect(mocks.parse).toHaveBeenCalledTimes(1);
    expect(sentPairs()).toEqual([
      ["coalition-ledesk-a", "coalition-ledesk-b"],
      ["kyiv-guardian", "kyiv-france24"],
      ["england-espn-a", "england-espn-b"],
      ["schools-bfm", "schools-npr"],
      ["schools-bfm", "schools-figaro"],
      ["schools-figaro", "schools-npr"],
      // A keep-separate pair reaches Haiku, which answers no.
      ["bonds-world-finance", "bonds-markets"],
    ]);
  });

  it("merges nothing on score alone: when Haiku says no to every pair, the day stays as it was", async () => {
    mocks.parse.mockImplementation(async (params) => ({
      parsed_output: { verdicts: sentPairs([params]).map((_, pair) => ({ pair, same: false })) },
    }));

    const input = day();
    const result = await merge(input);

    expect(result.merged).toBe(0);
    expect(result.items).toEqual(input);
  });
});

describe("same-pattern different events", () => {
  it("sends every one to Haiku and merges none of them, even at 0.935", async () => {
    const items = SAME_PATTERN_DIFFERENT_EVENTS.flat().map((f) => item(f));

    const result = await merge(items);

    expect(sentPairs()).toHaveLength(SAME_PATTERN_DIFFERENT_EVENTS.length);
    expect(result.merged).toBe(0);
    expect(ids(result.items)).toEqual(ids(items));
  });

  it("merges the lowest-scoring real duplicate (0.599), across two units", async () => {
    const [a, b] = REWORDED_SAME_EVENT;

    const result = await merge([item(a), item(b)]);

    expect(result.merged).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe("runs with nothing to compare make no call", () => {
  it("with no sentences: no embedding, no Haiku, the same items back", async () => {
    const items = MUST_MERGE[0].map((f) => item(f, { event: undefined }));

    const result = await merge(items);

    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(result).toEqual({ items, merged: 0, haikuCalls: 0 });
    result.items.forEach((it, i) => expect(it).toBe(items[i]));
  });

  it("with one sentence, or sentences only on rejected clusters: no embedding", async () => {
    const [a, b] = MUST_MERGE[0];
    await merge([item(a), item(b, { event: "  " })]);
    await merge([item(a, { notable: false }), item(b, { notable: false })]);

    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("with no pair above the threshold: embeds, but makes no call", async () => {
    const result = await merge(BACKGROUND.map((f) => item(f)));

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(result.haikuCalls).toBe(0);
    expect(result.merged).toBe(0);
  });

  it("leaves rejected clusters out of the comparison even when they carry a sentence", async () => {
    const [a, b] = MUST_MERGE[0];
    const [c] = BACKGROUND;

    const result = await merge([item(a), item(b, { notable: false }), item(c)]);

    expect(mocks.parse).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(3);
  });
});

describe("failures merge nothing and never reject", () => {
  const pair = () => MUST_MERGE[0].map((f) => item(f));

  it("a failed call", async () => {
    mocks.parse.mockRejectedValue(new Error("overloaded"));
    const items = pair();

    const result = await merge(items);

    expect(result).toEqual({ items, merged: 0, haikuCalls: 1 });
  });

  it("a truncated or refused call with no parsed output", async () => {
    mocks.parse.mockResolvedValue({ parsed_output: null, stop_reason: "max_tokens" });

    const result = await merge(pair());

    expect(result.merged).toBe(0);
    expect(result.haikuCalls).toBe(1);
  });

  it("a failed embedding, before any call", async () => {
    mocks.embed.mockRejectedValue(new Error("model missing"));

    const result = await merge(pair());

    expect(result).toEqual({ items: pair(), merged: 0, haikuCalls: 0 });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("a console that throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("closed stdout");
    });

    const result = await merge(pair());

    expect(result.merged).toBe(1);
  });

  it("ignores out-of-range, non-integer and repeated pair numbers; the first verdict for a pair wins", async () => {
    mocks.parse.mockResolvedValue({
      parsed_output: {
        verdicts: [
          { pair: 0, same: false },
          { pair: 0, same: true },
          { pair: 5, same: true },
          { pair: -1, same: true },
          { pair: 0.5, same: true },
        ],
      },
    });

    const result = await merge(pair());

    expect(result.merged).toBe(0);
  });
});

describe("the cap", () => {
  it("sends at most 30 pairs, the highest-scoring ones, and the rest stay separate", async () => {
    const { MAX_PAIRS_PER_RUN } = await import("@/lib/mergeDuplicates");
    // 9 clusters whose sentences all score against each other: 36 pairs.
    const many: FixtureCluster[] = Array.from({ length: 9 }, (_, i) => ({
      id: `m${i}`,
      topic: "Football",
      source: "ESPN",
      language: "en",
      event: `Match report ${i}.`,
    }));
    for (let i = 0; i < 9; i += 1) {
      for (let j = i + 1; j < 9; j += 1) MEASURED_SCORES[`m${i}|m${j}`] = 0.6 + (i * 9 + j) / 1000;
    }
    try {
      mocks.parse.mockImplementation(async (params) => ({
        parsed_output: { verdicts: sentPairs([params]).map((_, pair) => ({ pair, same: false })) },
      }));

      await merge(many.map((f) => item(f)));

      const sent = sentPairs();
      expect(sent).toHaveLength(MAX_PAIRS_PER_RUN);
      const scores = sent.map(([a, b]) => scoreOf(a, b));
      expect(scores).toEqual([...scores].sort((x, y) => y - x));
      // The six lowest of 36 (0.601 to 0.606) are the ones left out.
      expect(Math.min(...scores)).toBeCloseTo(0.607, 6);
    } finally {
      for (const key of Object.keys(MEASURED_SCORES)) if (key.startsWith("m")) delete MEASURED_SCORES[key];
    }
  });
});

describe("which cluster is kept", () => {
  const [a, b] = MUST_MERGE[2]; // Kyiv: Geopolitics, then Defense & Security in UNITS

  it("the higher severity, carrying it", async () => {
    const result = await merge([item(a, { severity: 2 }), item(b, { severity: 4 })]);

    expect(ids(result.items)).toEqual([b.id]);
    expect(result.items[0].severity).toBe(4);
    expect(result.items[0].cluster.topic).toBe("Defense & Security");
    expect(result.items[0].cluster.articles.map((x) => x.source)).toEqual(["France24", "The Guardian"]);
  });

  it("then more articles", async () => {
    const result = await merge([item(a, {}, 1), item(b, {}, 3)]);

    expect(ids(result.items)).toEqual([b.id]);
  });

  it("then the earlier reading unit", async () => {
    const units: ReadingUnit[] = [
      { topic: "Defense & Security", subtopic: null },
      { topic: "Geopolitics", subtopic: null },
    ];

    const result = await merge([item(a), item(b)], units);

    expect(ids(result.items)).toEqual([b.id]);
    expect(result.items[0].cluster.topic).toBe("Defense & Security");
  });

  it("then the earlier position, and a unit missing from the order ranks last", async () => {
    expect(ids((await merge([item(a), item(b)])).items)).toEqual([a.id]);
    expect(ids((await merge([item(a), item(b)], [{ topic: "Defense & Security", subtopic: null }])).items)).toEqual([b.id]);
  });

  it("keeps the kept member's country", async () => {
    const [x, y] = MUST_MERGE[3];
    const result = await merge([item({ ...x, subtopic: "Morocco" }, { severity: 2 }), item({ ...y, topic: "Morocco Politics", subtopic: undefined }, { severity: 3 })]);

    expect(result.items[0].cluster.topic).toBe("Morocco Politics");
    expect("subtopic" in result.items[0].cluster).toBe(false);
  });
});

describe("merging articles", () => {
  it("drops an article the group already holds under the same normalised URL", async () => {
    const [a, b] = MUST_MERGE[0];
    const first = item(a, { severity: 4 });
    const second = item(b);
    second.cluster.articles.push({ ...first.cluster.articles[0], url: `${first.cluster.articles[0].url}/?utm_source=rss`, source: "BBC" });

    const result = await merge([first, second]);

    expect(result.items[0].cluster.articles.map((x) => x.url)).toEqual([
      "https://example.com/england-espn-a/0",
      "https://example.com/england-espn-b/0",
    ]);
  });

  it("merges transitively and deterministically when the third pair was never asked about", async () => {
    // A=B and B=C confirmed; A~C scores under the threshold, so Haiku never
    // judged it and nothing stands against the chain.
    const chain: FixtureCluster[] = ["t-a", "t-b", "t-c"].map((id) => ({
      id,
      topic: "Football",
      source: "ESPN",
      language: "en",
      event: `Sentence ${id}.`,
    }));
    MEASURED_SCORES["t-a|t-b"] = 0.8;
    MEASURED_SCORES["t-b|t-c"] = 0.7;
    mocks.parse.mockImplementation(async (params) => ({
      parsed_output: { verdicts: sentPairs([params]).map((_, pair) => ({ pair, same: true })) },
    }));
    try {
      const once = await merge(chain.map((f) => item(f)));
      const again = await merge(chain.map((f) => item(f)));

      expect(sentPairs()).toEqual([
        ["t-a", "t-b"],
        ["t-b", "t-c"],
      ]);
      expect(once.merged).toBe(2);
      expect(ids(once.items)).toEqual(["t-a"]);
      expect(once.items[0].cluster.articles.map((a) => a.url)).toEqual([
        "https://example.com/t-a/0",
        "https://example.com/t-b/0",
        "https://example.com/t-c/0",
      ]);
      expect(again.items).toEqual(once.items);
    } finally {
      delete MEASURED_SCORES["t-a|t-b"];
      delete MEASURED_SCORES["t-b|t-c"];
    }
  });

  it("never lets a chain override an explicit 'different events': a roundup cannot bridge the Fed and the Bank of England", async () => {
    const [fed, boe] = SAME_PATTERN_DIFFERENT_EVENTS[4];
    const roundup: FixtureCluster = {
      id: "rates-roundup",
      topic: "Economy",
      source: "Bloomberg",
      language: "en",
      event: "The Federal Reserve and the Bank of England both held interest rates steady this week.",
    };
    MEASURED_SCORES["rates-fed|rates-roundup"] = 0.82;
    MEASURED_SCORES["rates-boe|rates-roundup"] = 0.8;
    try {
      // The roundup "reports" each decision, so Haiku says yes to both
      // bridges, and no to Fed vs BoE.
      mocks.parse.mockImplementation(async (params) => ({
        parsed_output: {
          verdicts: sentPairs([params]).map(([x, y], pair) => ({
            pair,
            same: x === "rates-roundup" || y === "rates-roundup",
          })),
        },
      }));

      const result = await merge([item(fed), item(boe), item(roundup)]);

      expect(sentPairs()).toHaveLength(3);
      // Highest-scoring bridge applied (Fed + roundup); the second would join
      // the BoE to the Fed and is skipped.
      expect(result.merged).toBe(1);
      expect(ids(result.items)).toEqual(["rates-fed", "rates-boe"]);
      expect(result.items[0].cluster.articles.map((a) => a.source)).toEqual(["CNBC", "Bloomberg"]);
      expect(result.items[1].cluster.articles).toHaveLength(1);
    } finally {
      delete MEASURED_SCORES["rates-fed|rates-roundup"];
      delete MEASURED_SCORES["rates-boe|rates-roundup"];
    }
  });

  it("treats a pair Haiku left unanswered as refused when a chain would join it", async () => {
    const group = MUST_MERGE[1].map((f) => item(f));
    // bfm~npr and bfm~figaro answered yes; figaro~npr left out of the reply.
    mocks.parse.mockImplementation(async (params) => ({
      parsed_output: {
        verdicts: sentPairs([params])
          .map(([x, y], pair) => ({ pair, same: true, x, y }))
          .filter((v) => !(v.x === "schools-figaro" && v.y === "schools-npr"))
          .map(({ pair, same }) => ({ pair, same })),
      },
    }));

    const result = await merge(group);

    // bfm~npr (0.779) is applied first; bfm~figaro would join figaro to npr.
    expect(result.merged).toBe(1);
    expect(ids(result.items)).toEqual(["schools-bfm", "schools-figaro"]);
  });

  it("passes rejected and unrelated items through untouched and in order", async () => {
    const rejected = item(BACKGROUND[0], { notable: false, event: undefined });
    const [a, b] = MUST_MERGE[0];
    const items = [rejected, item(a), item(BACKGROUND[1]), item(b)];

    const result = await merge(items);

    expect(ids(result.items)).toEqual([BACKGROUND[0].id, a.id, BACKGROUND[1].id]);
    expect(result.items[0]).toBe(items[0]);
    expect(result.items[2]).toBe(items[2]);
  });
});

describe("the call", () => {
  it("is one Haiku call stating Tarek's rule, with a bounded output", async () => {
    await merge(MUST_NOT_MERGE[0].map((f) => item(f)).concat(MUST_MERGE[0].map((f) => item(f))));

    const params = mocks.parse.mock.calls[0][0];
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.max_tokens).toBe(1024);
    expect(params.system).toContain("same real-world event");
    expect(params.system).toContain("Related angles on one situation");
    expect(params.system).toContain("A follow-up or a later development");
    expect(params.system).toContain("Two separate events of the same kind");
    expect(params.system).toContain("When in doubt, answer false.");
    expect(params.messages[0].content).toContain("Headline: england-espn-a headline 0");
  });

  it("is metered as the merge stage", async () => {
    const { createUsageCollector, withUsageCollector } = await import("@/lib/usageCollector");
    const usage = createUsageCollector();

    await withUsageCollector(usage, () => merge(MUST_MERGE[0].map((f) => item(f))));

    expect(usage.calls().map((c) => [c.stage, c.model, c.tokens?.inputTokens])).toEqual([["merge", "claude-haiku-4-5", 100]]);
  });

  it("logs one line per absorbed cluster with its score", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await merge(MUST_MERGE[2].map((f) => item(f)));

    expect(log).toHaveBeenCalledWith(
      `[merge] Geopolitics ← Defense & Security: "${MUST_MERGE[2][1].event}" (0.794, haiku)`,
    );
  });
});

describe("grades on a merged cluster (the cap has already run, so items may carry the boost)", () => {
  const [a, b] = MUST_MERGE[2];

  it("picks the keeper on triage's own grade, not the boosted one", async () => {
    // a: triage 3, boosted to 4. b: triage 4, not boosted.
    const result = await merge([item(a, { severity: 4, triageSeverity: 3 }), item(b, { severity: 4 })]);

    expect(ids(result.items)).toEqual([b.id]);
  });

  it("carries the group's highest boosted severity and highest triage grade", async () => {
    const result = await merge([item(a, { severity: 4, triageSeverity: 3 }), item(b, { severity: 2 })]);

    expect(result.items[0]).toMatchObject({ id: a.id, severity: 4, triageSeverity: 3 });
  });

  it("adds no triage grade when no member was boosted", async () => {
    const result = await merge([item(a, { severity: 2 }), item(b, { severity: 3 })]);

    expect(result.items[0].severity).toBe(3);
    expect("triageSeverity" in result.items[0]).toBe(false);
  });
});
