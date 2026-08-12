import { describe, it, expect } from "vitest";
import { applyRankUpdates } from "@/lib/rankUpdates";
import type { Card } from "@/types";

function card(id: string, frontPageRank: number | null): Card {
  return {
    id,
    topic: "Tech/AI",
    title: `Title ${id}`,
    shortSummary: `Summary ${id}`,
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-08-12T09:00:00.000Z",
    generatedAt: "2026-08-12T09:15:00.000Z",
    bookmarked: false,
    severity: 3,
    frontPageRank,
  };
}

describe("applyRankUpdates", () => {
  it("returns the same array reference when there are no updates", () => {
    // The fail-open path: ranking skipped or errored server-side sends an
    // empty list, which must mean "change nothing" — and cheaply, since
    // this runs on every done event.
    const cards = [card("a", 1), card("b", 2)];
    expect(applyRankUpdates(cards, [])).toBe(cards);
  });

  it("applies a promotion onto the front page", () => {
    const cards = [card("a", null)];
    const result = applyRankUpdates(cards, [{ id: "a", frontPageRank: 1 }]);
    expect(result[0].frontPageRank).toBe(1);
  });

  it("applies a demotion to null", () => {
    // The test that pins the undefined-vs-null lookup. A falsy check would
    // silently skip this, leaving a dethroned card rendering hero-sized
    // next to the real new #1 — the exact bug this function exists to fix.
    const cards = [card("a", 1)];
    const result = applyRankUpdates(cards, [{ id: "a", frontPageRank: null }]);
    expect(result[0].frontPageRank).toBeNull();
  });

  it("applies a rank change to a lower position", () => {
    const cards = [card("a", 1), card("b", 2)];
    const result = applyRankUpdates(cards, [
      { id: "a", frontPageRank: 3 },
      { id: "b", frontPageRank: 1 },
    ]);
    expect(result.map((c) => c.frontPageRank)).toEqual([3, 1]);
  });

  it("ignores ids that aren't in the card list", () => {
    // A client's snapshot can legitimately predate a card generated in
    // another tab — that's not an error.
    const cards = [card("a", 1)];
    const result = applyRankUpdates(cards, [{ id: "nonexistent", frontPageRank: 2 }]);
    expect(result).toHaveLength(1);
    expect(result[0].frontPageRank).toBe(1);
  });

  it("preserves object identity for cards it doesn't touch", () => {
    // Untouched cards keep their reference so React can skip re-rendering
    // them — worth pinning, since a naive spread-everything implementation
    // would pass every other assertion in this file.
    const untouched = card("a", 1);
    const result = applyRankUpdates([untouched, card("b", 2)], [{ id: "b", frontPageRank: 5 }]);
    expect(result[0]).toBe(untouched);
    expect(result[1]).not.toBe(untouched);
  });

  it("never adds, removes, or reorders cards", () => {
    const cards = [card("a", 1), card("b", null), card("c", 3)];
    const result = applyRankUpdates(cards, [
      { id: "c", frontPageRank: null },
      { id: "b", frontPageRank: 2 },
    ]);
    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array or its cards", () => {
    const cards = [card("a", 1)];
    applyRankUpdates(cards, [{ id: "a", frontPageRank: null }]);
    expect(cards[0].frontPageRank).toBe(1);
  });
});
