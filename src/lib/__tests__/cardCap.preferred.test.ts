import { describe, expect, it } from "vitest";
import { FIRST_RUN_CARDS_PER_TOPIC, TOP_UP_CARDS_PER_TOPIC, applyCardCap, type CardCapOptions } from "@/lib/cardCap";
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";

const TOPIC = TOPICS[0] as Topic;
const [PICKED, PICKED_TOO, OTHER, OTHER_TOO] = SOURCES.slice(0, 4) as Source[];

// A top-up keeps 2 per topic, so three candidates force exactly one cut.
const TOP_UP: CardCapOptions = { runShape: "sameDayTopUp", existingCards: [] };

function item(label: string, severity: number, sources: Source[]) {
  const cluster: Cluster = {
    topic: TOPIC,
    articles: sources.map((source, i) => ({
      title: `${label}-${i}`,
      snippet: "",
      url: `https://example.com/${label}/${i}`,
      source,
      topic: TOPIC,
      publishedAt: "2026-10-02T12:00:00Z",
    })),
  };
  return { label, cluster, severity };
}

const labels = (kept: { label: string }[]) => kept.map((k) => k.label);

describe("applyCardCap with preferred sources", () => {
  it("is the allowance this file assumes", () => {
    expect(TOP_UP_CARDS_PER_TOPIC).toBe(2);
  });

  it("orders by severity first: a preferred source never beats a higher severity", () => {
    const input = [item("a", 3, [OTHER]), item("b", 4, [OTHER]), item("c", 2, [PICKED, PICKED_TOO])];
    expect(labels(applyCardCap(input, { ...TOP_UP, preferredSources: [PICKED, PICKED_TOO] }).kept)).toEqual(["a", "b"]);
  });

  it("then by the number of preferred outlets, ahead of article count", () => {
    // Same severity. "many" has the most articles but no picked outlet;
    // "one" has one picked outlet; "two" has two. Two slots: two, then one.
    const input = [
      item("many", 3, [OTHER, OTHER_TOO, OTHER, OTHER_TOO]),
      item("one", 3, [PICKED]),
      item("two", 3, [PICKED, PICKED_TOO]),
    ];
    const { kept, cuts } = applyCardCap(input, { ...TOP_UP, preferredSources: [PICKED, PICKED_TOO] });
    expect(labels(kept)).toEqual(["one", "two"]);
    expect(cuts).toEqual([{ topic: TOPIC, subtopic: null, allowance: 2, dropped: 1, total: 3, severities: [3] }]);
  });

  it("counts distinct preferred outlets, not articles: one outlet filing twice is one", () => {
    const input = [
      item("same-outlet-twice", 3, [PICKED, PICKED]),
      item("two-outlets", 3, [PICKED, PICKED_TOO]),
      item("none", 3, [OTHER, OTHER_TOO, OTHER]),
    ];
    // same-outlet-twice and none would tie on preferred count only if the
    // count were per article; per outlet, two-outlets leads, then
    // same-outlet-twice (1 preferred) over none (0).
    const { kept } = applyCardCap(input, { ...TOP_UP, preferredSources: [PICKED, PICKED_TOO] });
    expect(labels(kept)).toEqual(["same-outlet-twice", "two-outlets"]);
  });

  it("falls back to article count, then input order, when preferred counts tie", () => {
    const input = [item("first", 3, [PICKED]), item("second", 3, [PICKED]), item("bigger", 3, [PICKED, OTHER])];
    expect(labels(applyCardCap(input, { ...TOP_UP, preferredSources: [PICKED] }).kept)).toEqual(["first", "bigger"]);
  });

  it("with zero preferences keeps exactly what it kept before (severity, article count, order)", () => {
    const input = [
      item("many", 3, [OTHER, OTHER_TOO, OTHER]),
      item("one", 3, [PICKED]),
      item("two", 3, [PICKED, PICKED_TOO]),
    ];
    const without = applyCardCap(input, TOP_UP);
    expect(labels(without.kept)).toEqual(["many", "two"]);
    expect(applyCardCap(input, { ...TOP_UP, preferredSources: [] })).toEqual(without);
    expect(applyCardCap(input, { ...TOP_UP, preferredSources: undefined })).toEqual(without);
  });

  it("still preserves input order in what it keeps", () => {
    const input = [
      item("x", 3, [OTHER]),
      ...Array.from({ length: FIRST_RUN_CARDS_PER_TOPIC }, (_, i) => item(`p${i}`, 3, [PICKED])),
    ];
    const { kept } = applyCardCap(input, { runShape: "firstOfDay", existingCards: [], preferredSources: [PICKED] });
    expect(labels(kept)).toEqual(input.slice(1).map((i) => i.label));
  });
});
