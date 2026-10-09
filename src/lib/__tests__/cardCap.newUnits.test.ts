import { describe, expect, it } from "vitest";
import {
  DAILY_CARDS_PER_TOPIC_CEILING,
  FIRST_RUN_CARDS_PER_TOPIC,
  TOP_UP_CARDS_PER_TOPIC,
  applyCardCap,
  unitRunAllowance,
  type TriagedCluster,
} from "@/lib/cardCap";
import { unitKey } from "@/lib/readingUnits";
import { COUNTRIES_TOPIC } from "@/config/countries";
import type { Cluster, Topic } from "@/types";

// A unit no run has read before (a topic or country picked since the last
// run) gets a first run's allowance on any run, so "Complete today's news"
// after adding a topic writes it a real section. Everything else keeps the
// run's allowance, and the daily ceiling still bounds both.

function group(topic: Topic, n: number, subtopic: string | null = null): TriagedCluster[] {
  return Array.from({ length: n }, (_, i) => {
    const cluster: Cluster = {
      topic,
      subtopic,
      articles: [
        {
          title: `${topic}-${subtopic}-${i}`,
          snippet: "snippet",
          url: `https://example.com/${topic}-${subtopic}-${i}`,
          source: "BBC",
          topic,
          subtopic,
          publishedAt: "2026-10-09T10:00:00Z",
        },
      ],
    };
    return { cluster, severity: Math.max(1, 5 - i) };
  });
}

const keptFor = (kept: TriagedCluster[], topic: Topic, subtopic: string | null = null) =>
  kept.filter((k) => k.cluster.topic === topic && (k.cluster.subtopic || null) === subtopic).length;

describe("unitRunAllowance", () => {
  it("gives a new unit the first-run allowance and leaves every other unit the run's", () => {
    expect(unitRunAllowance(TOP_UP_CARDS_PER_TOPIC, true, true)).toBe(FIRST_RUN_CARDS_PER_TOPIC);
    expect(unitRunAllowance(TOP_UP_CARDS_PER_TOPIC, false, true)).toBe(TOP_UP_CARDS_PER_TOPIC);
    expect(unitRunAllowance(FIRST_RUN_CARDS_PER_TOPIC, false, true)).toBe(FIRST_RUN_CARDS_PER_TOPIC);
  });
});

describe("applyCardCap with newUnits", () => {
  it("on a top-up, writes a new topic a full first edition and keeps the old topic at the top-up's two", () => {
    const notable = [...group("Tech/AI", 12), ...group("Space", 12)];
    const { kept } = applyCardCap(notable, {
      runShape: "sameDayTopUp",
      existingCards: Array.from({ length: 5 }, () => ({ topic: "Tech/AI" as Topic })),
      newUnits: new Set([unitKey("Space", null)]),
    });

    expect(keptFor(kept, "Tech/AI")).toBe(TOP_UP_CARDS_PER_TOPIC);
    expect(keptFor(kept, "Space")).toBe(FIRST_RUN_CARDS_PER_TOPIC);
  });

  it("treats a new country as its own unit, apart from countries already read", () => {
    const notable = [...group(COUNTRIES_TOPIC as Topic, 10, "France"), ...group(COUNTRIES_TOPIC as Topic, 10, "Kenya")];
    const { kept } = applyCardCap(notable, {
      runShape: "sameDayTopUp",
      existingCards: [{ topic: COUNTRIES_TOPIC as Topic, subtopic: "France" }],
      newUnits: new Set([unitKey(COUNTRIES_TOPIC as Topic, "Kenya")]),
    });

    expect(keptFor(kept, COUNTRIES_TOPIC as Topic, "France")).toBe(TOP_UP_CARDS_PER_TOPIC);
    expect(keptFor(kept, COUNTRIES_TOPIC as Topic, "Kenya")).toBe(FIRST_RUN_CARDS_PER_TOPIC);
  });

  it("still applies the daily ceiling to a new unit", () => {
    const already = DAILY_CARDS_PER_TOPIC_CEILING - 3;
    const { kept } = applyCardCap(group("Space", 12), {
      runShape: "sameDayTopUp",
      existingCards: Array.from({ length: already }, () => ({ topic: "Space" as Topic })),
      newUnits: new Set([unitKey("Space", null)]),
    });

    expect(keptFor(kept, "Space")).toBe(3);
  });

  it("changes nothing when no unit is new", () => {
    const notable = [...group("Tech/AI", 12), ...group("Space", 12)];
    const without = applyCardCap(notable, { runShape: "sameDayTopUp", existingCards: [] });
    const withEmpty = applyCardCap(notable, { runShape: "sameDayTopUp", existingCards: [], newUnits: new Set() });

    expect(keptFor(without.kept, "Space")).toBe(TOP_UP_CARDS_PER_TOPIC);
    expect(withEmpty.kept).toEqual(without.kept);
  });

  it("keeps a new unit at the top-up allowance when today's cards couldn't be read", () => {
    // A unit picked again after being dropped can already have cards today,
    // and without the count the daily ceiling can't hold.
    const notable = [...group("Tech/AI", 12), ...group("Space", 12)];
    const { kept } = applyCardCap(notable, {
      runShape: "unknown",
      existingCards: null,
      newUnits: new Set([unitKey("Space", null)]),
    });

    expect(keptFor(kept, "Tech/AI")).toBe(TOP_UP_CARDS_PER_TOPIC);
    expect(keptFor(kept, "Space")).toBe(TOP_UP_CARDS_PER_TOPIC);
  });
});
