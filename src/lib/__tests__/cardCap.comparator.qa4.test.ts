import { describe, it, expect } from "vitest";
import {
  applyCardCap,
  FIRST_RUN_CARDS_PER_TOPIC,
  TOP_UP_CARDS_PER_TOPIC,
  type CardCapOptions,
  type TriagedCluster,
} from "@/lib/cardCap";
import { boostPreferredClusters, countPreferredSources, MAX_SEVERITY } from "@/lib/preferredSources";
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";

// QA round 4: property checks on the card cap's comparator once the boost
// stores triage's own grade. Seeded random inputs are compared against a
// reference ranking written out longhand. Never names a topic or an outlet.

const [T1, T2] = TOPICS.slice(0, 2) as Topic[];
const [P1, P2, O1, O2] = SOURCES.slice(0, 4) as Source[];
const PREFERRED = [P1, P2];
const POOL: Source[] = [P1, P2, O1, O2];

type Item = { label: string; cluster: Cluster; notable: boolean; severity: number; triageSeverity?: number };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function makeItem(label: string, topic: Topic, severity: number, sources: Source[]): Item {
  return {
    label,
    notable: true,
    severity,
    cluster: {
      topic,
      articles: sources.map((source, i) => ({
        title: `${label}-${i}`,
        snippet: "",
        url: `https://ex.test/${label}/${i}`,
        source,
        topic,
        publishedAt: "2026-10-02T12:00:00Z",
      })),
    },
  };
}

function randomItems(seed: number, n: number): Item[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const count = 1 + Math.floor(r() * 4);
    const sources = Array.from({ length: count }, () => POOL[Math.floor(r() * POOL.length)]);
    return makeItem(`i${i}`, r() < 0.7 ? T1 : T2, 1 + Math.floor(r() * MAX_SEVERITY), sources);
  });
}

/** The documented ordering, longhand: per topic, the top `allowance` by key, input order last. */
function reference(items: TriagedCluster[], allowance: number, preferred: readonly Source[] | undefined): Set<number> {
  const keyOf = (it: TriagedCluster) => [
    it.severity,
    it.triageSeverity ?? 0,
    countPreferredSources(it.cluster.articles, preferred),
    it.cluster.articles.length,
  ];
  const kept = new Set<number>();
  const topics = [...new Set(items.map((i) => i.cluster.topic))];
  for (const topic of topics) {
    const idx = items.map((_, i) => i).filter((i) => items[i].cluster.topic === topic);
    idx.sort((a, b) => {
      const ka = keyOf(items[a]);
      const kb = keyOf(items[b]);
      for (let k = 0; k < ka.length; k++) if (ka[k] !== kb[k]) return kb[k] - ka[k];
      return a - b;
    });
    idx.slice(0, allowance).forEach((i) => kept.add(i));
  }
  return kept;
}

/** The base commit's ordering: severity, then article count, then input order. */
function baseReference(items: TriagedCluster[], allowance: number): Set<number> {
  const kept = new Set<number>();
  for (const topic of new Set(items.map((i) => i.cluster.topic))) {
    const idx = items.map((_, i) => i).filter((i) => items[i].cluster.topic === topic);
    idx.sort(
      (a, b) =>
        items[b].severity - items[a].severity ||
        items[b].cluster.articles.length - items[a].cluster.articles.length ||
        a - b
    );
    idx.slice(0, allowance).forEach((i) => kept.add(i));
  }
  return kept;
}

function keptIndices<T extends TriagedCluster>(items: T[], options: CardCapOptions): Set<number> {
  const { kept } = applyCardCap(items, options);
  return new Set(kept.map((k) => items.indexOf(k)));
}

const TOP_UP: CardCapOptions = { runShape: "sameDayTopUp", existingCards: [] };
const FIRST: CardCapOptions = { runShape: "firstOfDay", existingCards: [] };
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe("zero preferences: the cap is the base commit's cap, exactly", () => {
  it("boost adds no triageSeverity key at all when nothing is picked", () => {
    const { items } = boostPreferredClusters(randomItems(7, 12), []);
    expect(items.some((i) => "triageSeverity" in i)).toBe(false);
  });

  it.each([
    ["top-up", TOP_UP, TOP_UP_CARDS_PER_TOPIC],
    ["first run", FIRST, FIRST_RUN_CARDS_PER_TOPIC],
  ] as const)("%s: 300 random pools keep the same set as the base ordering", (_l, opts, allowance) => {
    for (const seed of SEEDS) {
      const items = boostPreferredClusters(randomItems(seed, 14), undefined).items;
      expect(keptIndices(items, { ...opts, preferredSources: [] }), `seed ${seed}`).toEqual(baseReference(items, allowance));
    }
  });
});

describe("with preferences: the cap matches the documented key order", () => {
  it("300 random pools after the boost match the longhand reference", () => {
    for (const seed of SEEDS) {
      const items = boostPreferredClusters(randomItems(seed, 14), PREFERRED).items;
      expect(keptIndices(items, { ...TOP_UP, preferredSources: PREFERRED }), `seed ${seed}`).toEqual(
        reference(items, TOP_UP_CARDS_PER_TOPIC, PREFERRED)
      );
    }
  });

  it("the result does not depend on how the engine's sort visits pairs: reversing input only moves exact ties", () => {
    for (const seed of SEEDS) {
      const items = boostPreferredClusters(randomItems(seed, 14), PREFERRED).items;
      const keyOf = (it: Item) =>
        JSON.stringify([it.severity, it.triageSeverity ?? 0, countPreferredSources(it.cluster.articles, PREFERRED), it.cluster.articles.length, it.cluster.topic]);
      const fwd = applyCardCap(items, { ...TOP_UP, preferredSources: PREFERRED }).kept.map(keyOf).sort();
      const rev = applyCardCap([...items].reverse(), { ...TOP_UP, preferredSources: PREFERRED }).kept.map(keyOf).sort();
      expect(rev, `seed ${seed}`).toEqual(fwd);
    }
  });
});

describe("the boost's two promises, over random pools", () => {
  it("two boosted stories are never kept against triage's order", () => {
    for (const seed of SEEDS) {
      const items = boostPreferredClusters(randomItems(seed, 14), PREFERRED).items;
      const kept = keptIndices(items, { ...TOP_UP, preferredSources: PREFERRED });
      items.forEach((a, i) =>
        items.forEach((b, j) => {
          if (a.cluster.topic !== b.cluster.topic) return;
          if (a.triageSeverity === undefined || b.triageSeverity === undefined) return;
          if (a.triageSeverity > b.triageSeverity && kept.has(j)) {
            expect(kept.has(i), `seed ${seed}: ${a.label}(t${a.triageSeverity}) dropped for ${b.label}(t${b.triageSeverity})`).toBe(true);
          }
        })
      );
    }
  });

  it("a boosted story is never dropped while an unboosted one at the same or lower severity is kept", () => {
    for (const seed of SEEDS) {
      const items = boostPreferredClusters(randomItems(seed, 14), PREFERRED).items;
      const kept = keptIndices(items, { ...TOP_UP, preferredSources: PREFERRED });
      items.forEach((b, i) =>
        items.forEach((u, j) => {
          if (b.cluster.topic !== u.cluster.topic) return;
          if (b.triageSeverity === undefined || u.triageSeverity !== undefined) return;
          if (b.severity >= u.severity && kept.has(j)) expect(kept.has(i), `seed ${seed}`).toBe(true);
        })
      );
    }
  });

  it("an unboosted story at a higher severity than a boosted one is never dropped for it", () => {
    for (const seed of SEEDS) {
      const items = boostPreferredClusters(randomItems(seed, 14), PREFERRED).items;
      const kept = keptIndices(items, { ...TOP_UP, preferredSources: PREFERRED });
      items.forEach((u, i) =>
        items.forEach((b, j) => {
          if (b.cluster.topic !== u.cluster.topic) return;
          if (b.triageSeverity === undefined || u.triageSeverity !== undefined) return;
          if (u.severity > b.severity && kept.has(j)) expect(kept.has(i), `seed ${seed}`).toBe(true);
        })
      );
    }
  });
});

describe("mismatched callers", () => {
  it("items never boosted, but the cap given preferences: preferred count orders equal severities", () => {
    const items = [makeItem("plain", T1, 5, [O1, O2, O1]), makeItem("one-pref", T1, 5, [P1]), makeItem("two-pref", T1, 5, [P1, P2])];
    const kept = applyCardCap(items, { ...TOP_UP, preferredSources: PREFERRED }).kept.map((k) => k.label);
    expect(kept).toEqual(["one-pref", "two-pref"]);
  });

  it("boosted items, but the cap given no preferences: triage's grade still orders the boosted ones", () => {
    const boosted = boostPreferredClusters(
      [makeItem("t4", T1, 4, [P1, O1, O2]), makeItem("t5", T1, 5, [P1]), makeItem("t4b", T1, 4, [P2, O1, O2])],
      PREFERRED
    ).items;
    // 13 existing cards leave one slot under the ceiling.
    const keptOneSlot = applyCardCap(boosted, {
      runShape: "sameDayTopUp",
      existingCards: Array.from({ length: 13 }, () => ({ topic: T1 })),
    }).kept.map((k) => k.label);
    expect(keptOneSlot).toEqual(["t5"]);
  });

  it("a plain TriagedCluster with no triageSeverity loses a tie to a boosted one whatever its article count", () => {
    const boosted = boostPreferredClusters([makeItem("boosted4", T1, 4, [P1])], PREFERRED).items[0];
    const plain: Item = makeItem("plain5", T1, 5, [O1, O2, O1, O2, O1]);
    const kept = applyCardCap([plain, boosted], { runShape: "sameDayTopUp", existingCards: Array.from({ length: 13 }, () => ({ topic: T1 })) }).kept;
    expect(kept.map((k) => k.label)).toEqual(["boosted4"]);
  });
});

describe("what leaves the cap", () => {
  it("kept items carry the boosted severity (what writeCard is given) and the original grade alongside it", () => {
    const boosted = boostPreferredClusters([makeItem("b", T1, 4, [P1]), makeItem("c", T1, 5, [P2])], PREFERRED).items;
    const { kept } = applyCardCap(boosted, { ...TOP_UP, preferredSources: PREFERRED });
    expect(kept.map((k) => [k.label, k.severity, k.triageSeverity])).toEqual([
      ["b", 5, 4],
      ["c", 5, 5],
    ]);
  });

  it("cuts report the boosted severity of what was dropped, and a dropped boosted story ranks after its boosted peer", () => {
    const boosted = boostPreferredClusters(
      [makeItem("t3", T1, 3, [P1]), makeItem("t5", T1, 5, [P1]), makeItem("t4", T1, 4, [P1])],
      PREFERRED
    ).items;
    const { kept, cuts } = applyCardCap(boosted, { ...TOP_UP, preferredSources: PREFERRED });
    expect(kept.map((k) => k.label)).toEqual(["t5", "t4"]);
    expect(cuts).toEqual([{ topic: T1, allowance: TOP_UP_CARDS_PER_TOPIC, dropped: 1, total: 3, severities: [4] }]);
  });
});
