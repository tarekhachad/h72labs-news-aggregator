import { describe, expect, it } from "vitest";
import {
  DAILY_CARDS_PER_TOPIC_CEILING,
  FIRST_RUN_CARDS_PER_TOPIC,
  TOP_UP_CARDS_PER_TOPIC,
  applyCardCap,
} from "@/lib/cardCap";
import { TOPICS, type Cluster, type Topic } from "@/types";

// Each picked country is a full topic for the cap: its own allowance and its
// own ceiling, counted only against cards of the same country.

const COUNTRIES = "Countries" as Topic;
const OTHER = TOPICS[0] as Topic;

function item(label: string, topic: Topic, subtopic: string | null | undefined, severity = 3) {
  const cluster: Cluster = {
    topic,
    ...(subtopic === undefined ? {} : { subtopic }),
    articles: [
      {
        title: label,
        snippet: "",
        url: `https://example.com/${label}`,
        source: "BBC",
        topic,
        publishedAt: "2026-10-03T12:00:00Z",
      },
    ],
  };
  return { label, cluster, severity };
}

const many = (prefix: string, topic: Topic, subtopic: string | null, n: number) =>
  Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, topic, subtopic));

const cards = (topic: Topic, subtopic: string | null, n: number) =>
  Array.from({ length: n }, () => ({ topic, subtopic }));

describe("applyCardCap per country", () => {
  it("gives each country the full first-run allowance", () => {
    const input = [...many("u", COUNTRIES, "Uganda", 10), ...many("k", COUNTRIES, "Kenya", 10)];
    const { kept, cuts } = applyCardCap(input, { runShape: "firstOfDay", existingCards: [] });

    expect(kept.filter((k) => k.cluster.subtopic === "Uganda")).toHaveLength(FIRST_RUN_CARDS_PER_TOPIC);
    expect(kept.filter((k) => k.cluster.subtopic === "Kenya")).toHaveLength(FIRST_RUN_CARDS_PER_TOPIC);
    expect(cuts.map((c) => [c.topic, c.subtopic, c.dropped])).toEqual([
      [COUNTRIES, "Uganda", 2],
      [COUNTRIES, "Kenya", 2],
    ]);
  });

  it("counts a country's existing cards against that country only", () => {
    // Uganda is one short of the ceiling; Kenya has nothing yet.
    const existing = cards(COUNTRIES, "Uganda", DAILY_CARDS_PER_TOPIC_CEILING - 1);
    const input = [...many("u", COUNTRIES, "Uganda", 3), ...many("k", COUNTRIES, "Kenya", 3)];
    const { kept } = applyCardCap(input, { runShape: "sameDayTopUp", existingCards: existing });

    expect(kept.filter((k) => k.cluster.subtopic === "Uganda")).toHaveLength(1);
    expect(kept.filter((k) => k.cluster.subtopic === "Kenya")).toHaveLength(TOP_UP_CARDS_PER_TOPIC);
  });

  it("keeps a full country from eating into a plain topic's ceiling, and the other way round", () => {
    const existing = [
      ...cards(COUNTRIES, "Uganda", DAILY_CARDS_PER_TOPIC_CEILING),
      ...cards(OTHER, null, DAILY_CARDS_PER_TOPIC_CEILING),
    ];
    const input = [...many("k", COUNTRIES, "Kenya", 3), ...many("o", OTHER, null, 3), ...many("u", COUNTRIES, "Uganda", 3)];
    const { kept } = applyCardCap(input, { runShape: "sameDayTopUp", existingCards: existing });

    expect(kept.map((k) => k.label)).toEqual(["k0", "k1"]);
  });

  it("treats a missing subtopic, null and an empty string as the same unit", () => {
    const input = [item("a", OTHER, undefined), item("b", OTHER, null), item("c", OTHER, "")];
    const { kept, cuts } = applyCardCap(input, { runShape: "sameDayTopUp", existingCards: [{ topic: OTHER }] });

    expect(kept).toHaveLength(TOP_UP_CARDS_PER_TOPIC);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].subtopic).toBeNull();
  });

  it("reports a plain topic's cut with a null subtopic", () => {
    const { cuts } = applyCardCap(many("o", OTHER, null, 3), { runShape: "sameDayTopUp", existingCards: [] });
    expect(cuts).toEqual([
      expect.objectContaining({ topic: OTHER, subtopic: null, dropped: 1 }),
    ]);
  });
});
