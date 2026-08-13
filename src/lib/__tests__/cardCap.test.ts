import { describe, expect, it } from "vitest";
import { MAX_CARDS_PER_TOPIC, applyCardCap } from "@/lib/cardCap";
import type { Cluster, Topic } from "@/types";

function item(topic: Topic, severity: number, title = "t") {
  const cluster: Cluster = {
    topic,
    articles: [
      {
        title,
        snippet: "snippet",
        url: `https://example.com/${title}`,
        source: "BBC",
        topic,
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
  return { cluster, severity };
}

/** `n` clusters in one topic, severities descending from `topSeverity`. */
function group(topic: Topic, n: number, topSeverity = 5) {
  return Array.from({ length: n }, (_, i) =>
    item(topic, Math.max(1, topSeverity - i), `${topic}-${i}`)
  );
}

describe("applyCardCap", () => {
  it("keeps everything when a topic is under the cap", () => {
    const input = group("Tech/AI", 3);
    expect(applyCardCap(input).kept).toEqual(input);
  });

  it("keeps everything when a topic is exactly at the cap", () => {
    const input = group("Tech/AI", MAX_CARDS_PER_TOPIC);
    expect(applyCardCap(input).kept).toEqual(input);
  });

  it("keeps the highest-severity clusters when a topic is over the cap", () => {
    // 12 clusters, severities 5,4,3,2,1,1,1,1,1,1,1,1 — the cap must take
    // the genuinely most significant, not just the first 8 encountered.
    const input = [
      item("Tech/AI", 1, "low-a"),
      item("Tech/AI", 5, "high"),
      ...group("Tech/AI", 10, 4),
    ];
    const { kept } = applyCardCap(input);

    expect(kept).toHaveLength(MAX_CARDS_PER_TOPIC);
    expect(kept.map((k) => k.severity).sort((a, b) => b - a)).toEqual([5, 4, 3, 2, 1, 1, 1, 1]);
    expect(kept).toContainEqual(input[1]);
  });

  // The result feeds writeCard and then the rank candidate pool, whose
  // index alignment the route depends on. A cap that also reordered would
  // be a silent, hard-to-trace source of misapplied ranks.
  it("returns a subsequence of the input, not a severity-ranked list", () => {
    const input = [
      item("Tech/AI", 1, "first"),
      item("Tech/AI", 5, "second"),
      item("Tech/AI", 3, "third"),
      ...group("Tech/AI", 9, 4),
    ];
    const { kept } = applyCardCap(input);
    const positions = kept.map((k) => input.indexOf(k));

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("does not mutate or reorder the input array", () => {
    const input = [...group("Tech/AI", 12, 5)];
    const snapshot = [...input];
    applyCardCap(input);
    expect(input).toEqual(snapshot);
  });

  it("caps each topic independently", () => {
    const input = [
      ...group("Tech/AI", 12, 5),
      ...group("Morocco", 2, 5),
      ...group("Geopolitics", 20, 5),
    ];
    const { kept } = applyCardCap(input);
    const perTopic = (topic: Topic) => kept.filter((k) => k.cluster.topic === topic).length;

    expect(perTopic("Tech/AI")).toBe(MAX_CARDS_PER_TOPIC);
    expect(perTopic("Morocco")).toBe(2);
    expect(perTopic("Geopolitics")).toBe(MAX_CARDS_PER_TOPIC);
  });

  // The "minimum 4 per topic" intent is a ceiling-side target, never a
  // quota: a thin topic yields what actually passed triage. Backfilling
  // would contradict the triage prompt's own "don't stretch to fill a
  // quota" and pay to write a story it already rejected.
  it("never invents cards for a topic that came up thin", () => {
    const input = group("World Finance", 2, 3);
    expect(applyCardCap(input).kept).toHaveLength(2);
  });

  it("handles an empty list", () => {
    expect(applyCardCap([]).kept).toEqual([]);
  });

  // Selection is tracked by index, not object identity, precisely so this
  // holds. A Set keyed on the items themselves can't tell two array slots
  // holding the same reference apart, so one duplicated reference lets a
  // topic exceed its own cap — the cap talked out of capping. Nothing in
  // today's pipeline produces this input; the guarantee shouldn't depend on
  // that staying true.
  it("still caps when the same object appears twice in the input", () => {
    const dup = item("Tech/AI", 5, "dup");
    const input = [dup, ...group("Tech/AI", 8, 5), dup];

    const { kept, cuts } = applyCardCap(input);

    // Exactly the cap, not merely "no more than": 10 slots over a cap of 8
    // is fully determined, and an under-selecting fix (say, one that
    // collapsed both dup slots and returned 7) would slip past a
    // less-than-or-equal assertion.
    expect(kept).toHaveLength(MAX_CARDS_PER_TOPIC);
    expect(cuts[0].dropped).toBe(input.length - MAX_CARDS_PER_TOPIC);
  });

  it("reports a cut consistent with what it actually kept", () => {
    const input = [...group("Tech/AI", 11, 5), ...group("Morocco", 20, 5)];
    const { kept, cuts } = applyCardCap(input);

    // The two halves of the return value must describe the same operation:
    // total − dropped = kept, per topic. They're computed together so they
    // can't drift, and this is the assertion that pins that.
    for (const cut of cuts) {
      const keptForTopic = kept.filter((k) => k.cluster.topic === cut.topic).length;
      expect(cut.total - cut.dropped).toBe(keptForTopic);
    }
    expect(cuts.reduce((n, c) => n + c.dropped, 0)).toBe(input.length - kept.length);
  });

  it("breaks ties at the boundary by input order, deterministically", () => {
    // 10 clusters all at severity 3 — the first 8 win, every time.
    const input = group("Tech/AI", 10, 3).map((i) => ({ ...i, severity: 3 }));
    const { kept } = applyCardCap(input);
    expect(kept).toEqual(input.slice(0, MAX_CARDS_PER_TOPIC));
  });
});

describe("applyCardCap cuts", () => {
  it("reports nothing when no topic was over the cap", () => {
    const input = group("Tech/AI", 3);
    expect(applyCardCap(input).cuts).toEqual([]);
  });

  it("reports the topic, counts, and the severities that were cut", () => {
    const input = [...group("Tech/AI", 10, 5), ...group("Morocco", 2, 5)];
    const { cuts } = applyCardCap(input);

    expect(cuts).toHaveLength(1);
    expect(cuts[0].topic).toBe("Tech/AI");
    expect(cuts[0].dropped).toBe(2);
    expect(cuts[0].total).toBe(10);
    // severities 5,4,3,2,1,1,1,1 kept; 1,1 dropped
    expect(cuts[0].severities).toEqual([1, 1]);
  });
});
