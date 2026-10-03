import { describe, expect, it } from "vitest";
import {
  MAX_SEVERITY,
  PREFERRED_SEVERITY_BOOST,
  boostPreferredClusters,
  countPreferredSources,
  orderPreferredFirst,
} from "@/lib/preferredSources";
import { applyCardCap } from "@/lib/cardCap";
import { FAIL_CLOSED, isFailClosed, type TriageOutcome } from "@/lib/triageOutcome";
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";

const TOPIC = TOPICS[0] as Topic;
const [PICKED, PICKED_TOO, OTHER, OTHER_TOO] = SOURCES.slice(0, 4) as Source[];

function cluster(sources: Source[]): Cluster {
  return {
    topic: TOPIC,
    articles: sources.map((source, i) => ({
      title: `t${i}`,
      snippet: "",
      url: `https://example.com/${i}`,
      source,
      topic: TOPIC,
      publishedAt: "2026-10-02T12:00:00Z",
    })),
  };
}

/** The route's shape: a cluster paired with the verdict triage returned. */
function triaged(label: string, sources: Source[], outcome: TriageOutcome) {
  return { label, cluster: cluster(sources), notable: outcome.notable, severity: outcome.severity, outcome };
}

describe("countPreferredSources", () => {
  it("counts distinct preferred outlets", () => {
    const items = [{ source: PICKED }, { source: PICKED }, { source: PICKED_TOO }, { source: OTHER }];
    expect(countPreferredSources(items, [PICKED, PICKED_TOO])).toBe(2);
    expect(countPreferredSources(items, [PICKED])).toBe(1);
    expect(countPreferredSources(items, [OTHER_TOO])).toBe(0);
  });

  it("is zero with no preferences, absent or empty", () => {
    expect(countPreferredSources([{ source: PICKED }], [])).toBe(0);
    expect(countPreferredSources([{ source: PICKED }], undefined)).toBe(0);
  });
});

describe("orderPreferredFirst", () => {
  const items = [
    { source: OTHER, n: 1 },
    { source: PICKED, n: 2 },
    { source: OTHER_TOO, n: 3 },
    { source: PICKED_TOO, n: 4 },
    { source: PICKED, n: 5 },
  ];

  it("moves preferred outlets to the front, stable within each group", () => {
    expect(orderPreferredFirst(items, [PICKED_TOO, PICKED]).map((i) => i.n)).toEqual([2, 4, 5, 1, 3]);
  });

  it("is the input order with no preferences, or none present", () => {
    expect(orderPreferredFirst(items, [])).toEqual(items);
    expect(orderPreferredFirst(items, undefined)).toEqual(items);
    expect(orderPreferredFirst(items, [SOURCES[10] as Source])).toEqual(items);
  });

  it("returns a new array and leaves the input alone", () => {
    const copy = [...items];
    const out = orderPreferredFirst(items, [PICKED]);
    expect(out).not.toBe(items);
    expect(orderPreferredFirst(items, [])).not.toBe(items);
    expect(items).toEqual(copy);
  });
});

describe("boostPreferredClusters", () => {
  const notable = (severity: number): TriageOutcome => ({ notable: true, severity });
  const rejected: TriageOutcome = { notable: false, severity: 1 };

  it("is +1, capped at 5", () => {
    expect(PREFERRED_SEVERITY_BOOST).toBe(1);
    expect(MAX_SEVERITY).toBe(5);
  });

  it("adds one to a judged-notable cluster a preferred outlet covered", () => {
    const { items, boosted } = boostPreferredClusters([triaged("a", [OTHER, PICKED], notable(2))], [PICKED]);
    expect(items[0].severity).toBe(3);
    expect(boosted).toBe(1);
  });

  it("caps at 5, and still counts the cluster as boosted", () => {
    const { items, boosted } = boostPreferredClusters(
      [triaged("four", [PICKED], notable(4)), triaged("five", [PICKED], notable(5))],
      [PICKED]
    );
    expect(items.map((i) => i.severity)).toEqual([5, 5]);
    expect(boosted).toBe(2);
  });

  it("adds one however many preferred outlets covered the story", () => {
    const { items } = boostPreferredClusters([triaged("a", [PICKED, PICKED_TOO], notable(1))], [PICKED, PICKED_TOO]);
    expect(items[0].severity).toBe(2);
  });

  it("never boosts a fail-closed cluster: triage couldn't judge it, so it stays out", () => {
    const failed = triaged("failed", [PICKED], FAIL_CLOSED);
    const { items, boosted } = boostPreferredClusters([failed], [PICKED]);
    expect(items[0]).toBe(failed);
    expect(items[0].notable).toBe(false);
    expect(isFailClosed(items[0].outcome)).toBe(true);
    expect(boosted).toBe(0);
  });

  it("never turns a judged reject into a notable story", () => {
    const { items, boosted } = boostPreferredClusters([triaged("no", [PICKED], rejected)], [PICKED]);
    expect(items[0].notable).toBe(false);
    expect(items[0].severity).toBe(1);
    expect(boosted).toBe(0);
  });

  it("leaves a cluster without a preferred outlet untouched", () => {
    const plain = triaged("plain", [OTHER], notable(3));
    const { items, boosted } = boostPreferredClusters([plain], [PICKED]);
    expect(items[0]).toBe(plain);
    expect(boosted).toBe(0);
  });

  it("changes nothing with zero preferences", () => {
    const input = [triaged("a", [PICKED], notable(2)), triaged("b", [OTHER], notable(4)), triaged("c", [PICKED], FAIL_CLOSED)];
    for (const preferred of [[], undefined]) {
      const { items, boosted } = boostPreferredClusters(input, preferred);
      expect(items).toEqual(input);
      items.forEach((item, i) => expect(item).toBe(input[i]));
      expect(boosted).toBe(0);
    }
  });

  it("does not mutate its input", () => {
    const input = [triaged("a", [PICKED], notable(2))];
    boostPreferredClusters(input, [PICKED]);
    expect(input[0].severity).toBe(2);
  });

  it("lets a boosted cluster cross the card cap's bar that it would otherwise miss", () => {
    // A top-up keeps 2 per topic. Unboosted, the two severity-3 stories win
    // and the severity-2 preferred one is cut. Boosted to 3 it ties them,
    // and its preferred outlet wins the tie.
    const input = [
      triaged("plain-1", [OTHER, OTHER_TOO], notable(3)),
      triaged("plain-2", [OTHER], notable(3)),
      triaged("preferred", [PICKED], notable(2)),
    ];
    const options = { runShape: "sameDayTopUp" as const, existingCards: [], preferredSources: [PICKED] };

    const unboosted = applyCardCap(input, options).kept.map((k) => k.label);
    expect(unboosted).toEqual(["plain-1", "plain-2"]);

    const { items } = boostPreferredClusters(input, [PICKED]);
    const kept = applyCardCap(items.filter((t) => t.notable), options).kept.map((k) => k.label);
    expect(kept).toEqual(["plain-1", "preferred"]);
  });
});
