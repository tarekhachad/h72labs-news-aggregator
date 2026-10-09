import { describe, it, expect } from "vitest";
import type { Cluster, Topic } from "@/types";
import {
  applyCardCap,
  unitRunAllowance,
  FIRST_RUN_CARDS_PER_TOPIC,
  TOP_UP_CARDS_PER_TOPIC,
  DAILY_CARDS_PER_TOPIC_CEILING,
  type TriagedCluster,
} from "@/lib/cardCap";
import { unitKey } from "@/lib/readingUnits";
import type { RunShape } from "@/lib/usageRecord";

// QA: newUnits across every run shape, the ceiling boundary, and key shapes.

function clusters(topic: string, n: number, subtopic?: string): TriagedCluster[] {
  return Array.from({ length: n }, (_, i) => ({
    cluster: {
      topic: topic as Topic,
      ...(subtopic !== undefined ? { subtopic } : {}),
      articles: [{ title: `${i}`, snippet: "", url: `u${topic}${subtopic}${i}`, source: "BBC", topic: topic as Topic, publishedAt: "2026-10-09T00:00:00Z" }],
    } as Cluster,
    severity: 3,
  }));
}

function keptCount(kept: TriagedCluster[], topic: string, subtopic: string | null = null): number {
  return kept.filter((k) => k.cluster.topic === topic && (k.cluster.subtopic || null) === subtopic).length;
}

const existing = (topic: string, n: number, subtopic: string | null = null) =>
  Array.from({ length: n }, () => ({ topic: topic as Topic, subtopic }));

describe("unitRunAllowance", () => {
  it("is the first-run allowance for a new unit and the run's for an old one", () => {
    expect(unitRunAllowance(TOP_UP_CARDS_PER_TOPIC, true, true)).toBe(FIRST_RUN_CARDS_PER_TOPIC);
    expect(unitRunAllowance(TOP_UP_CARDS_PER_TOPIC, false, true)).toBe(TOP_UP_CARDS_PER_TOPIC);
    expect(unitRunAllowance(FIRST_RUN_CARDS_PER_TOPIC, false, true)).toBe(FIRST_RUN_CARDS_PER_TOPIC);
  });

  it("keeps the run's allowance for a new unit when today's cards are unknown", () => {
    expect(unitRunAllowance(TOP_UP_CARDS_PER_TOPIC, true, false)).toBe(TOP_UP_CARDS_PER_TOPIC);
  });
});

describe("applyCardCap with newUnits, per run shape", () => {
  // [shape, new unit, old unit]. With today's cards unknown the ceiling can't
  // hold, so a new unit keeps the run's allowance too.
  const shapes: [RunShape, number, number][] = [
    ["firstEver", 8, 8],
    ["firstOfDay", 8, 8],
    ["sameDayTopUp", 8, 2],
    ["unknown", 2, 2],
  ];
  for (const [shape, newAllowance, oldAllowance] of shapes) {
    it(`${shape}: new unit ${newAllowance}, old unit ${oldAllowance}`, () => {
      const { kept } = applyCardCap([...clusters("Tech/AI", 12), ...clusters("Space", 12)], {
        runShape: shape,
        existingCards: shape === "unknown" ? null : [],
        newUnits: new Set([unitKey("Space", null)]),
      });
      expect(keptCount(kept, "Space")).toBe(newAllowance);
      expect(keptCount(kept, "Tech/AI")).toBe(oldAllowance);
    });
  }

  it("ceiling boundary: 6 existing -> 8, 7 -> 7, 14 -> 0, 20 -> 0", () => {
    for (const [n, want] of [[6, 8], [7, 7], [DAILY_CARDS_PER_TOPIC_CEILING, 0], [20, 0]] as const) {
      const { kept, cuts } = applyCardCap(clusters("Space", 12), {
        runShape: "sameDayTopUp",
        existingCards: existing("Space", n),
        newUnits: new Set([unitKey("Space", null)]),
      });
      expect(keptCount(kept, "Space")).toBe(want);
      expect(cuts[0].allowance).toBe(want);
    }
  });

  it("an empty newUnits set is the same as none", () => {
    const opts = { runShape: "sameDayTopUp" as const, existingCards: [] };
    const a = applyCardCap(clusters("Space", 12), { ...opts, newUnits: new Set() });
    const b = applyCardCap(clusters("Space", 12), opts);
    expect(keptCount(a.kept, "Space")).toBe(2);
    expect(keptCount(b.kept, "Space")).toBe(2);
  });

  it("a cluster whose subtopic is '' matches a new unit keyed with null", () => {
    const { kept } = applyCardCap(clusters("Space", 12, ""), {
      runShape: "sameDayTopUp",
      existingCards: [],
      newUnits: new Set([unitKey("Space", null)]),
    });
    expect(keptCount(kept, "Space")).toBe(8);
  });

  it("a new country does not lift another country or the plain topics", () => {
    const { kept } = applyCardCap(
      [...clusters("Countries", 12, "Kenya"), ...clusters("Countries", 12, "France"), ...clusters("Tech/AI", 12)],
      { runShape: "sameDayTopUp", existingCards: [], newUnits: new Set([unitKey("Countries", "Kenya")]) }
    );
    expect(keptCount(kept, "Countries", "Kenya")).toBe(8);
    expect(keptCount(kept, "Countries", "France")).toBe(2);
    expect(keptCount(kept, "Tech/AI")).toBe(2);
  });

  it("a key that is not a unitKey (raw topic string) lifts nothing", () => {
    const { kept } = applyCardCap(clusters("Space", 12), {
      runShape: "sameDayTopUp",
      existingCards: [],
      newUnits: new Set(["Space"]),
    });
    expect(keptCount(kept, "Space")).toBe(2);
  });
});
