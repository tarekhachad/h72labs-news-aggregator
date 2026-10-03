import { describe, it, expect } from "vitest";
import { SOURCES, TOPICS, type Card, type Source } from "@/types";
import { orderBySeverity } from "@/components/newspaper/TopicPage";

// Topic-page order: severity first, then how many of the reader's preferred
// outlets a story carries, then recency, then id. Names come from SOURCES by
// position because the catalog is changing under this lane.

const [A, B, C, D] = SOURCES;

function card(id: string, severity: number, publishedAt: string, outlets: Source[]): Card {
  return {
    id,
    topic: TOPICS[0],
    title: id,
    shortSummary: "",
    labels: [],
    expandedReport: null,
    sources: outlets.map((source, i) => ({
      title: `${id}-${i}`,
      url: `https://example.test/${id}/${i}`,
      source,
      snippet: "",
    })),
    publishedAt,
    generatedAt: "2026-10-02T06:00:00Z",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

const ids = (cards: Card[]) => cards.map((c) => c.id);

describe("orderBySeverity", () => {
  // `newer` wins today's recency tiebreak; `older` carries more preferred outlets.
  const newer = card("newer", 3, "2026-10-02T09:00:00Z", [C, D]);
  const older = card("older", 3, "2026-10-02T07:00:00Z", [A, B, C]);

  it("puts the same-severity story with more preferred sources first", () => {
    expect(ids(orderBySeverity([newer, older], [A, B]))).toEqual(["older", "newer"]);
  });

  it("leaves today's order unchanged with zero preferred sources", () => {
    expect(ids(orderBySeverity([older, newer], []))).toEqual(["newer", "older"]);
    expect(ids(orderBySeverity([older, newer]))).toEqual(["newer", "older"]);
  });

  it("never lets preferred sources outrank higher severity", () => {
    const severe = card("severe", 4, "2026-10-02T05:00:00Z", [D]);
    expect(ids(orderBySeverity([older, severe], [A, B]))).toEqual(["severe", "older"]);
  });

  it("counts distinct outlets, not articles", () => {
    // Two articles from one preferred outlet tie with one article from it,
    // so recency decides.
    const twoFromA = card("twoFromA", 3, "2026-10-02T07:00:00Z", [A, A]);
    const oneFromA = card("oneFromA", 3, "2026-10-02T08:00:00Z", [A]);
    expect(ids(orderBySeverity([twoFromA, oneFromA], [A]))).toEqual(["oneFromA", "twoFromA"]);

    const twoOutlets = card("twoOutlets", 3, "2026-10-02T06:00:00Z", [A, B]);
    expect(ids(orderBySeverity([twoFromA, twoOutlets], [A, B]))).toEqual([
      "twoOutlets",
      "twoFromA",
    ]);
  });

  it("falls back to recency, then id, when preferred counts tie", () => {
    const x = card("x", 2, "2026-10-02T08:00:00Z", [A]);
    const y = card("y", 2, "2026-10-02T08:00:00Z", [B]);
    expect(ids(orderBySeverity([y, x], [A, B]))).toEqual(["x", "y"]);
  });

  it("doesn't mutate the input", () => {
    const input = [newer, older];
    orderBySeverity(input, [A, B]);
    expect(ids(input)).toEqual(["newer", "older"]);
  });
});
