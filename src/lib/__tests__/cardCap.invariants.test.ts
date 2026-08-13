import { describe, expect, it } from "vitest";
import { MAX_CARDS_PER_TOPIC, applyCardCap, type TriagedCluster } from "@/lib/cardCap";
import type { Cluster, Topic } from "@/types";

// Independent audit of applyCardCap, written to a different standard than
// cardCap.test.ts: it re-derives the expected output by hand for each case
// rather than trusting the sibling file's assertions, plus a randomized fuzz
// pass over inputs too adversarial to hand-pick — duplicate object
// references being the case that already produced one real bug here.

function item(topic: Topic, severity: number, title = "t"): TriagedCluster {
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

function group(topic: Topic, n: number, topSeverity = 5): TriagedCluster[] {
  return Array.from({ length: n }, (_, i) =>
    item(topic, Math.max(1, topSeverity - i), `${topic}-${i}`)
  );
}

describe("applyCardCap — duplicate references, hand-derived", () => {
  it("exact kept count and dropped indices for a specific duplicate-reference input", () => {
    // input: [dup(sev5), group(8, topSeverity=5) => sev 5,4,3,2,1,1,1,1, dup(sev5)]
    // indices: 0=dup(5) 1=g0(5) 2=g1(4) 3=g2(3) 4=g3(2) 5=g4(1) 6=g5(1) 7=g6(1) 8=g7(1) 9=dup(5)
    // total 10 items, cap 8 -> drop 2 lowest-ranked (stable sort keeps ties in
    // original index order), which are indices 7 and 8 (last two sev-1 slots).
    const dup = item("Tech/AI", 5, "dup");
    const input = [dup, ...group("Tech/AI", 8, 5), dup];

    const { kept, cuts } = applyCardCap(input);

    expect(kept).toHaveLength(MAX_CARDS_PER_TOPIC); // exact, not <=
    expect(cuts).toHaveLength(1);
    expect(cuts[0].total).toBe(10);
    expect(cuts[0].dropped).toBe(2);
    expect(cuts[0].severities).toEqual([1, 1]);

    // Both physical slots holding `dup` (index 0 and index 9) should survive
    // — they're tied for highest severity in the whole set. Multiplicity of
    // the literal object reference in the output must be 2, matching the
    // number of surviving indices that reference it (this is exactly what
    // an identity-keyed Set gets wrong: it can't represent "kept twice").
    const dupCount = kept.filter((k) => k === dup).length;
    expect(dupCount).toBe(2);

    // Explicit index-by-index expectation, since indexOf-based order checks
    // can't disambiguate two positions holding the same reference.
    const expectedKeptInput = [input[0], input[1], input[2], input[3], input[4], input[5], input[6], input[9]];
    expect(kept).toEqual(expectedKeptInput);
  });

  it("order is preserved by true array position, not just indexOf, even with a repeated reference", () => {
    // Build input with a marker sequence so we can assert exact positional
    // identity rather than relying on indexOf (which always resolves a
    // duplicated reference to its FIRST occurrence and so can't catch a bug
    // that reorders the second occurrence).
    const dup = item("Tech/AI", 5, "dup");
    const input: TriagedCluster[] = [
      item("Tech/AI", 1, "a"),
      dup,
      item("Tech/AI", 4, "b"),
      item("Tech/AI", 4, "c"),
      item("Tech/AI", 4, "d"),
      item("Tech/AI", 4, "e"),
      item("Tech/AI", 4, "f"),
      item("Tech/AI", 4, "g"),
      item("Tech/AI", 4, "h"),
      dup, // second physical slot, same reference
    ];
    // severities: idx0="a"=1, idx1=dup=5, idx2..8="b".."h"=4 (7 items), idx9=dup=5.
    // 9 items sit at severity >= 4 (two 5s + seven 4s) but the cap is 8, so
    // exactly one of them must drop too — the lowest-index-order tie among
    // the sev-4 group, i.e. "h" (idx8) — on top of "a" (idx0, sev 1) which
    // was never in contention. Total dropped: "a" and "h".
    const { kept } = applyCardCap(input);

    const keptTitles = kept.map((k) => k.cluster.articles[0].title);
    expect(keptTitles).toEqual(["dup", "b", "c", "d", "e", "f", "g", "dup"]);
    // Confirms the SECOND dup slot (index 9) is the one whose position in the
    // output is index 7 (last), not swapped with the first dup's position.
    expect(kept[0]).toBe(dup);
    expect(kept[7]).toBe(dup);
    expect(kept[0]).toBe(kept[7]); // same reference, two legitimate slots
  });

  it("triple duplicate reference: cap still holds exactly and cuts stay internally consistent", () => {
    const dup = item("Tech/AI", 3, "dup");
    const input = [dup, dup, dup, ...group("Tech/AI", 9, 3)]; // 12 total, all sev<=3
    const { kept, cuts } = applyCardCap(input);

    expect(kept.length).toBe(MAX_CARDS_PER_TOPIC);
    expect(cuts[0].total).toBe(12);
    expect(cuts[0].dropped).toBe(4);
    expect(cuts[0].total - cuts[0].dropped).toBe(kept.length);
  });

  it("duplicate reference in a topic that never exceeds the cap is untouched (no artificial drop)", () => {
    const dup = item("Tech/AI", 5, "dup");
    const input = [dup, item("Tech/AI", 2, "x"), dup]; // 3 slots, cap 8 — under cap
    const { kept, cuts } = applyCardCap(input);

    expect(kept).toEqual(input);
    expect(cuts).toEqual([]);
    expect(kept.filter((k) => k === dup).length).toBe(2);
  });
});

describe("applyCardCap — fuzzed invariants", () => {
  function seededRandom(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  const TOPICS: Topic[] = ["Tech/AI", "Morocco", "Geopolitics"];

  it("holds across randomized inputs with duplicate references and duplicate severities", () => {
    const rand = seededRandom(42);

    for (let trial = 0; trial < 200; trial++) {
      const poolSize = 1 + Math.floor(rand() * 6); // small pool of distinct objects per topic
      const pools: Record<string, TriagedCluster[]> = {};
      for (const t of TOPICS) {
        pools[t] = Array.from({ length: poolSize }, (_, i) =>
          item(t, 1 + Math.floor(rand() * 5), `${t}-${i}`)
        );
      }

      const n = 1 + Math.floor(rand() * 30);
      const input: TriagedCluster[] = Array.from({ length: n }, () => {
        const t = TOPICS[Math.floor(rand() * TOPICS.length)];
        const pool = pools[t];
        return pool[Math.floor(rand() * pool.length)]; // may repeat references
      });

      const inputSnapshot = [...input];
      const { kept, cuts } = applyCardCap(input);

      // 1. Input never mutated.
      expect(input).toEqual(inputSnapshot);

      // 2. kept is a true subsequence of input (index-increasing map exists).
      let cursor = -1;
      for (const k of kept) {
        let found = -1;
        for (let i = cursor + 1; i < input.length; i++) {
          if (input[i] === k) {
            found = i;
            break;
          }
        }
        expect(found).toBeGreaterThan(cursor);
        cursor = found;
      }

      // 3. Per-topic cap never exceeded, and never fabricated beyond input count.
      for (const t of TOPICS) {
        const totalForTopic = input.filter((x) => x.cluster.topic === t).length;
        const keptForTopic = kept.filter((x) => x.cluster.topic === t).length;
        expect(keptForTopic).toBeLessThanOrEqual(MAX_CARDS_PER_TOPIC);
        expect(keptForTopic).toBeLessThanOrEqual(totalForTopic);
        expect(keptForTopic).toBe(Math.min(totalForTopic, MAX_CARDS_PER_TOPIC));
      }

      // 4. cuts <-> kept internal consistency, and cuts only for topics over cap.
      for (const cut of cuts) {
        const keptForTopic = kept.filter((x) => x.cluster.topic === cut.topic).length;
        expect(cut.total - cut.dropped).toBe(keptForTopic);
        expect(cut.total).toBeGreaterThan(MAX_CARDS_PER_TOPIC);
        expect(cut.severities).toHaveLength(cut.dropped);
      }
      const cutTopics = new Set(cuts.map((c) => c.topic));
      for (const t of TOPICS) {
        const totalForTopic = input.filter((x) => x.cluster.topic === t).length;
        if (totalForTopic > MAX_CARDS_PER_TOPIC) expect(cutTopics.has(t)).toBe(true);
        else expect(cutTopics.has(t)).toBe(false);
      }

      // 5. Global count identity.
      const totalDropped = cuts.reduce((s, c) => s + c.dropped, 0);
      expect(input.length - totalDropped).toBe(kept.length);

      // 6. Every kept item's severity is >= every dropped-and-same-topic item's
      // severity minus none (i.e. kept set for a capped topic is exactly the
      // top-MAX by severity, ties by original index) — verify by recomputing
      // independently per topic.
      for (const t of TOPICS) {
        const topicIndices = input
          .map((x, i) => ({ x, i }))
          .filter(({ x }) => x.cluster.topic === t)
          .map(({ i }) => i);
        if (topicIndices.length <= MAX_CARDS_PER_TOPIC) continue;
        const rankedDesc = [...topicIndices].sort(
          (a, b) => input[b].severity - input[a].severity
        );
        const expectedKeptIndices = new Set(rankedDesc.slice(0, MAX_CARDS_PER_TOPIC));
        const actualKeptIndices = new Set<number>();
        // Recover which input indices ended up in `kept` for this topic by
        // walking both arrays in lockstep respecting possible duplicate refs.
        let ki = 0;
        const keptForTopic = kept.filter((x) => x.cluster.topic === t);
        for (const idx of topicIndices) {
          if (ki < keptForTopic.length && input[idx] === keptForTopic[ki]) {
            actualKeptIndices.add(idx);
            ki++;
          }
        }
        expect(actualKeptIndices).toEqual(expectedKeptIndices);
      }
    }
  });
});
