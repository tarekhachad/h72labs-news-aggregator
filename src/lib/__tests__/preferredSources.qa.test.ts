import { describe, it, expect } from "vitest";
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";
import { FAIL_CLOSED } from "@/lib/triageOutcome";
import {
  boostPreferredClusters,
  countPreferredSources,
  orderPreferredFirst,
  MAX_SEVERITY,
  PREFERRED_SEVERITY_BOOST,
} from "@/lib/preferredSources";
import { applyCardCap, TOP_UP_CARDS_PER_TOPIC } from "@/lib/cardCap";
import { getTodaysCardSummaries } from "@/lib/digests";

// QA round 1: preferred-source helpers and their use in the card cap. Never
// names a topic or an outlet.

const TOPIC = TOPICS[0] as Topic;
const [P1, P2, O1, O2, O3] = SOURCES.slice(0, 5) as Source[];

function cluster(sources: Source[], label = "c"): Cluster {
  return {
    topic: TOPIC,
    articles: sources.map((source, i) => ({
      title: `${label}-${i}`,
      snippet: "",
      url: `https://ex.test/${label}/${i}`,
      source,
      topic: TOPIC,
      publishedAt: "2026-10-02T12:00:00Z",
    })),
  };
}

describe("countPreferredSources", () => {
  it("counts distinct outlets, not articles", () => {
    expect(countPreferredSources(cluster([P1, P1, P1]).articles, [P1, P2])).toBe(1);
    expect(countPreferredSources(cluster([P1, P2, O1]).articles, [P1, P2])).toBe(2);
  });
  it("is zero for absent, empty, or non-overlapping preferences", () => {
    const a = cluster([P1, O1]).articles;
    expect(countPreferredSources(a, undefined)).toBe(0);
    expect(countPreferredSources(a, [])).toBe(0);
    expect(countPreferredSources(a, [O3])).toBe(0);
    expect(countPreferredSources([], [P1])).toBe(0);
  });
  it("a duplicated preference does not double count", () => {
    expect(countPreferredSources(cluster([P1]).articles, [P1, P1])).toBe(1);
  });
});

describe("orderPreferredFirst", () => {
  it("is stable inside both groups and returns a new array", () => {
    const items = [O1, P2, O2, P1, O3, P2].map((source, i) => ({ source, i }));
    const out = orderPreferredFirst(items, [P1, P2]);
    expect(out.map((x) => x.i)).toEqual([1, 3, 5, 0, 2, 4]);
    expect(out).not.toBe(items);
    expect(orderPreferredFirst(items, []).map((x) => x.i)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(orderPreferredFirst(items, [])).not.toBe(items);
  });
});

describe("boostPreferredClusters", () => {
  it("never boosts FAIL_CLOSED, a reject, or a notable cluster with no preferred outlet", () => {
    const items = [
      { cluster: cluster([P1]), ...FAIL_CLOSED },
      { cluster: cluster([P1]), notable: false, severity: 4 },
      { cluster: cluster([O1]), notable: true, severity: 2 },
    ];
    const { items: out, boosted } = boostPreferredClusters(items, [P1]);
    expect(boosted).toBe(0);
    expect(out.map((x) => [x.notable, x.severity])).toEqual([
      [false, 1],
      [false, 4],
      [true, 2],
    ]);
  });

  it("adds exactly PREFERRED_SEVERITY_BOOST, capped at MAX_SEVERITY, for every severity", () => {
    for (let s = 1; s <= MAX_SEVERITY; s++) {
      const { items } = boostPreferredClusters([{ cluster: cluster([O1, P2]), notable: true, severity: s }], [P2]);
      expect(items[0].severity).toBe(Math.min(MAX_SEVERITY, s + PREFERRED_SEVERITY_BOOST));
    }
  });

  it("boosts once per cluster however many preferred outlets it has", () => {
    const { items } = boostPreferredClusters([{ cluster: cluster([P1, P2]), notable: true, severity: 2 }], [P1, P2]);
    expect(items[0].severity).toBe(2 + PREFERRED_SEVERITY_BOOST);
  });

  it("does not mutate input items, and keeps extra fields", () => {
    const item = { cluster: cluster([P1]), notable: true, severity: 2, extra: "kept" };
    const frozen = Object.freeze({ ...item });
    const { items } = boostPreferredClusters([frozen], [P1]);
    expect(frozen.severity).toBe(2);
    expect(items[0]).toMatchObject({ extra: "kept", severity: 3 });
  });

  it("returns a copy for no preferences, same elements", () => {
    const input = [{ cluster: cluster([P1]), notable: true, severity: 2 }];
    const { items, boosted } = boostPreferredClusters(input, undefined);
    expect(items).not.toBe(input);
    expect(items[0]).toBe(input[0]);
    expect(boosted).toBe(0);
  });
});

describe("applyCardCap with preferred sources", () => {
  // A same-day top-up keeps TOP_UP_CARDS_PER_TOPIC per topic.
  const opts = (preferredSources?: Source[]) => ({
    runShape: "sameDayTopUp" as const,
    existingCards: [],
    preferredSources,
  });

  it("severity still beats preferred-outlet count", () => {
    const notable = [
      { cluster: cluster([O1], "hi1"), notable: true, severity: 5 },
      { cluster: cluster([O2], "hi2"), notable: true, severity: 5 },
      { cluster: cluster([P1, P2], "lo"), notable: true, severity: 4 },
    ];
    expect(TOP_UP_CARDS_PER_TOPIC).toBe(2);
    const { kept } = applyCardCap(notable, opts([P1, P2]));
    expect(kept.map((k) => k.cluster.articles[0].title)).toEqual(["hi1-0", "hi2-0"]);
  });

  it("at equal severity, more distinct preferred outlets beats more articles", () => {
    const notable = [
      { cluster: cluster([O1, O2, O3, O1], "many"), notable: true, severity: 3 },
      { cluster: cluster([P1, O1], "one-pref"), notable: true, severity: 3 },
      { cluster: cluster([P1, P2], "two-pref"), notable: true, severity: 3 },
    ];
    const { kept } = applyCardCap(notable, opts([P1, P2]));
    expect(kept.map((k) => k.cluster.articles[0].title).sort()).toEqual(["one-pref-0", "two-pref-0"]);
  });

  it("a repeated preferred outlet does not count twice in the tie-break", () => {
    // Allowance 2: a clear winner takes one slot; the last slot is between
    // one outlet filing three times and two distinct preferred outlets.
    const notable = [
      { cluster: cluster([P1, P1, P1], "same"), notable: true, severity: 3 },
      { cluster: cluster([O1], "winner"), notable: true, severity: 4 },
      { cluster: cluster([P1, P2], "two"), notable: true, severity: 3 },
    ];
    const { kept } = applyCardCap(notable, opts([P1, P2]));
    expect(kept.map((k) => k.cluster.articles[0].title)).toEqual(["winner-0", "two-0"]);
  });
});

describe("getTodaysCardSummaries and malformed sources entries", () => {
  it("passes an array holding a null entry through, and countPreferredSources counts it as nothing", async () => {
    const rows = [{ id: "a", topic: TOPIC, short_summary: "x", severity: 2, sources: [null, { source: P1 }] }];
    const eq = async () => ({ data: rows, error: null });
    const client = { from: () => ({ select: () => ({ eq }) }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [summary] = await getTodaysCardSummaries(client as any, "d");
    expect(summary.sources).toEqual([null, { source: P1 }]);
    expect(countPreferredSources(summary.sources as never, [P1])).toBe(1);
  });
});
