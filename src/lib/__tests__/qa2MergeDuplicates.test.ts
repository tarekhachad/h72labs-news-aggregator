import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster, Source, Topic } from "@/types";
import type { ReadingUnit } from "@/lib/readingUnits";

// The refusal-blocking rule in applyMerges, checked against a
// brute-force reference on random graphs, plus the cases a narrow check could
// get wrong (direction of a refused pair, refused pairs unrelated to the edge)
// and verdict-order independence end to end. No real model, no real API.

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
  cosineSimilarity: (a: string[], b: string[]) =>
    mocks.scores.get(`${a[0]}|${b[0]}`) ?? mocks.scores.get(`${b[0]}|${a[0]}`) ?? 0.2,
}));

type Item = { cluster: Cluster; notable: boolean; severity: number; event?: string };
type Pair = { a: number; b: number; score: number };

function item(event: string, severity = 3, topic: Topic = "Geopolitics" as Topic): Item {
  return {
    cluster: {
      topic,
      articles: [
        {
          title: `${event} headline`,
          snippet: "",
          url: `https://example.com/${encodeURIComponent(event)}`,
          source: "BBC" as Source,
          topic,
          publishedAt: "2026-10-03T08:00:00Z",
        },
      ],
    },
    notable: true,
    severity,
    event,
  };
}

const UNITS: ReadingUnit[] = [{ topic: "Geopolitics", subtopic: null }];

function sentPairs(params: { messages: { content: string }[] }): [string, string][] {
  const out: [string, string][] = [];
  for (const block of params.messages[0].content.split(/\n\n(?=\d+\.\n)/)) {
    const a = /\nA: (.*)\n/.exec(block)?.[1];
    const b = /\nB: (.*)\n/.exec(block)?.[1];
    if (a && b) out.push([a, b]);
  }
  return out;
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

async function applyMerges(n: number, confirmed: Pair[], refused: Pair[]) {
  const mod = await import("@/lib/mergeDuplicates");
  const items = Array.from({ length: n }, (_, i) => item(`s${i}`));
  return mod.applyMerges(items, confirmed, UNITS, refused);
}

/** The groups applyMerges formed, as sorted member lists, singletons left out. */
function partition(n: number, groups: { keeper: number; absorbed: number[] }[]): number[][] {
  void n;
  return groups.map((g) => [g.keeper, ...g.absorbed].sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
}

/** Brute force: explicit member sets, applied in order, skip any join that puts a refused pair together. */
function reference(n: number, confirmed: Pair[], refused: Pair[]): number[][] {
  const groupOf = Array.from({ length: n }, (_, i) => new Set([i]));
  for (const { a, b } of confirmed) {
    const ga = groupOf[a];
    const gb = groupOf[b];
    if (ga === gb) continue;
    const blocked = refused.some(({ a: x, b: y }) => (ga.has(x) && gb.has(y)) || (gb.has(x) && ga.has(y)));
    if (blocked) continue;
    const union = new Set([...ga, ...gb]);
    for (const m of union) groupOf[m] = union;
  }
  const seen = new Set<Set<number>>();
  const out: number[][] = [];
  for (const g of groupOf) {
    if (seen.has(g) || g.size < 2) continue;
    seen.add(g);
    out.push([...g].sort((x, y) => x - y));
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("QA2: applyMerges refusal blocking", () => {
  it("matches a brute-force reference, never groups a refused pair, and skips only what a refusal blocks (500 random graphs)", async () => {
    const random = rng(42);
    for (let trial = 0; trial < 500; trial += 1) {
      const n = 2 + Math.floor(random() * 8);
      const confirmed: Pair[] = [];
      const refused: Pair[] = [];
      for (let a = 0; a < n; a += 1) {
        for (let b = a + 1; b < n; b += 1) {
          const roll = random();
          const pair = { a, b, score: 0.55 + random() * 0.45 };
          if (roll < 0.45) confirmed.push(pair);
          else if (roll < 0.75) refused.push(pair);
        }
      }
      confirmed.sort((x, y) => y.score - x.score);

      const result = await applyMerges(n, confirmed, refused);
      const groups = partition(n, result.groups);

      expect(groups, `trial ${trial}`).toEqual(reference(n, confirmed, refused));

      const groupIndex = new Map<number, number>();
      groups.forEach((g, k) => g.forEach((m) => groupIndex.set(m, k)));
      const together = (x: number, y: number) => groupIndex.has(x) && groupIndex.get(x) === groupIndex.get(y);
      // Never: a refused pair inside one group.
      for (const { a, b } of refused) expect(together(a, b), `trial ${trial} refused ${a}-${b}`).toBe(false);
      // A confirmed pair left apart is one a refusal blocks at the end state.
      const sameGroup = (x: number, g: number[]) => g.includes(x);
      for (const { a, b } of confirmed) {
        if (together(a, b)) continue;
        const ga = groups.find((g) => sameGroup(a, g)) ?? [a];
        const gb = groups.find((g) => sameGroup(b, g)) ?? [b];
        const blocked = refused.some(
          ({ a: x, b: y }) => (ga.includes(x) && gb.includes(y)) || (gb.includes(x) && ga.includes(y)),
        );
        expect(blocked, `trial ${trial} confirmed ${a}-${b} skipped without a refusal`).toBe(true);
      }
      // `applied` holds exactly the confirmed pairs that ended up together.
      expect(result.applied).toEqual(confirmed.filter(({ a, b }) => together(a, b)));
      expect(result.merged).toBe(groups.reduce((s, g) => s + g.length - 1, 0));
    }
  });

  it("does not depend on the order of the refused list", async () => {
    const random = rng(7);
    for (let trial = 0; trial < 200; trial += 1) {
      const n = 3 + Math.floor(random() * 6);
      const confirmed: Pair[] = [];
      const refused: Pair[] = [];
      for (let a = 0; a < n; a += 1) {
        for (let b = a + 1; b < n; b += 1) {
          const roll = random();
          if (roll < 0.5) confirmed.push({ a, b, score: random() });
          else if (roll < 0.8) refused.push({ a, b, score: random() });
        }
      }
      confirmed.sort((x, y) => y.score - x.score);
      const forward = await applyMerges(n, confirmed, refused);
      const backward = await applyMerges(n, confirmed, [...refused].reverse());
      expect(partition(n, backward.groups)).toEqual(partition(n, forward.groups));
    }
  });

  it("blocks a join when the refused pair runs from the second group back to the first", async () => {
    // {0,3} and {1,2} are formed first; joining them via 0~2 would put 1 and 3
    // together, which Haiku refused. The refused pair's lower index (1) sits in
    // the edge's SECOND group (2's), so a one-direction check misses it.
    const result = await applyMerges(
      4,
      [
        { a: 1, b: 2, score: 0.9 },
        { a: 0, b: 3, score: 0.8 },
        { a: 0, b: 2, score: 0.7 },
      ],
      [{ a: 1, b: 3, score: 0.6 }],
    );
    expect(partition(4, result.groups)).toEqual([
      [0, 3],
      [1, 2],
    ]);
    expect(result.merged).toBe(2);
  });

  it("blocks a join of two groups through members neither of which is on the confirmed edge", async () => {
    const result = await applyMerges(
      4,
      [
        { a: 0, b: 1, score: 0.9 },
        { a: 2, b: 3, score: 0.85 },
        { a: 0, b: 2, score: 0.7 },
      ],
      [{ a: 1, b: 3, score: 0.6 }],
    );
    expect(partition(4, result.groups)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("is not blocked by a refused pair with only one end in the groups being joined", async () => {
    // 0~2 refused, but 2 stays outside: joining 0 and 1 is fine.
    const result = await applyMerges(3, [{ a: 0, b: 1, score: 0.9 }], [{ a: 0, b: 2, score: 0.8 }]);
    expect(partition(3, result.groups)).toEqual([[0, 1]]);
  });

  it("is not blocked by a refused pair entirely elsewhere in the run", async () => {
    const result = await applyMerges(
      4,
      [{ a: 0, b: 1, score: 0.7 }],
      [{ a: 2, b: 3, score: 0.95 }],
    );
    expect(partition(4, result.groups)).toEqual([[0, 1]]);
  });

  it("keeps applying confirmed pairs inside a group already joined (a closed triangle stays one group)", async () => {
    const result = await applyMerges(
      3,
      [
        { a: 0, b: 1, score: 0.9 },
        { a: 1, b: 2, score: 0.8 },
        { a: 0, b: 2, score: 0.7 },
      ],
      [],
    );
    expect(partition(3, result.groups)).toEqual([[0, 1, 2]]);
    expect(result.applied).toHaveLength(3);
  });
});

describe("QA2: end to end, the bridging case does not depend on verdict order", () => {
  const FED = "The US Federal Reserve held rates steady.";
  const BOE = "The Bank of England held rates at 4 percent.";
  const ROUNDUP = "The Fed and the Bank of England both held rates this week.";

  function permutations<T>(xs: T[]): T[][] {
    if (xs.length <= 1) return [xs];
    return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
  }

  it("every order of Haiku's three verdicts gives the same two cards", async () => {
    mocks.scores.set(`${FED}|${ROUNDUP}`, 0.82);
    mocks.scores.set(`${BOE}|${ROUNDUP}`, 0.8);
    mocks.scores.set(`${FED}|${BOE}`, 0.71);
    const { mergeDuplicateClusters } = await import("@/lib/mergeDuplicates");
    const outcomes: string[] = [];
    for (const order of permutations([0, 1, 2])) {
      mocks.parse.mockImplementation(async (params) => {
        const verdicts = sentPairs(params).map(([x, y], pair) => ({ pair, same: x === ROUNDUP || y === ROUNDUP }));
        return { parsed_output: { verdicts: order.map((k) => verdicts[k]) } };
      });
      const result = await mergeDuplicateClusters([item(FED), item(BOE), item(ROUNDUP)], UNITS);
      expect(result.merged).toBe(1);
      expect(result.haikuCalls).toBe(1);
      outcomes.push(JSON.stringify(result.items.map((i) => [i.event, i.cluster.articles.length])));
    }
    expect(new Set(outcomes).size).toBe(1);
    // Fed + roundup (0.82) is applied; BoE stays its own card.
    expect(JSON.parse(outcomes[0])).toEqual([
      [FED, 2],
      [BOE, 1],
    ]);
  });

  it("an all-yes reply still merges all three: nothing was refused", async () => {
    mocks.scores.set(`${FED}|${ROUNDUP}`, 0.82);
    mocks.scores.set(`${BOE}|${ROUNDUP}`, 0.8);
    mocks.scores.set(`${FED}|${BOE}`, 0.71);
    mocks.parse.mockImplementation(async (params) => ({
      parsed_output: { verdicts: sentPairs(params).map((_, pair) => ({ pair, same: true })) },
    }));
    const { mergeDuplicateClusters } = await import("@/lib/mergeDuplicates");
    const result = await mergeDuplicateClusters([item(FED), item(BOE), item(ROUNDUP)], UNITS);
    expect(result.merged).toBe(2);
    expect(result.items).toHaveLength(1);
  });
});
