import { describe, expect, it } from "vitest";
import type { SavedCard } from "@/lib/bookmarks";
import type { Topic } from "@/types";
import {
  NO_SAVED_FILTER,
  activeSavedTopic,
  filterSavedCards,
  formatSavedDate,
  savedDateBounds,
  savedTopics,
} from "@/lib/savedFilters";

function saved(id: string, topic: string, date: string): SavedCard {
  return {
    id,
    topic: topic as Topic,
    title: id,
    shortSummary: "",
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: true,
    severity: 3,
    frontPageRank: null,
    date,
  };
}

// Newest-saved first, deliberately not in date order.
const CARDS = [
  saved("a", "Tech/AI", "2026-10-12"),
  saved("b", "Football", "2026-10-03"),
  saved("c", "Tech/AI", "2026-10-09"),
  saved("d", "Countries", "2026-10-12"),
];

const ids = (cards: SavedCard[]) => cards.map((c) => c.id);

describe("savedTopics", () => {
  it("lists each topic once, alphabetically", () => {
    expect(savedTopics(CARDS)).toEqual(["Countries", "Football", "Tech/AI"]);
  });
});

describe("savedDateBounds", () => {
  it("finds the earliest and latest day", () => {
    expect(savedDateBounds(CARDS)).toEqual({ min: "2026-10-03", max: "2026-10-12" });
  });

  it("ignores cards without a date, and is null when none has one", () => {
    expect(savedDateBounds([saved("x", "Football", ""), CARDS[1]])).toEqual({ min: "2026-10-03", max: "2026-10-03" });
    expect(savedDateBounds([saved("x", "Football", "")])).toBeNull();
  });
});

describe("filterSavedCards", () => {
  it("keeps everything, in order, with no filter", () => {
    expect(ids(filterSavedCards(CARDS, NO_SAVED_FILTER))).toEqual(["a", "b", "c", "d"]);
  });

  it("filters by topic, keeping the saved order", () => {
    expect(ids(filterSavedCards(CARDS, { ...NO_SAVED_FILTER, topic: "Tech/AI" }))).toEqual(["a", "c"]);
  });

  it("treats a topic no card has as All", () => {
    expect(activeSavedTopic(CARDS, "Markets & Investing")).toBeNull();
    expect(ids(filterSavedCards(CARDS, { ...NO_SAVED_FILTER, topic: "Markets & Investing" }))).toEqual(["a", "b", "c", "d"]);
  });

  it("includes both ends of a range", () => {
    expect(ids(filterSavedCards(CARDS, { topic: null, from: "2026-10-03", to: "2026-10-09" }))).toEqual(["b", "c"]);
  });

  it("filters to one day when From and To match", () => {
    expect(ids(filterSavedCards(CARDS, { topic: null, from: "2026-10-12", to: "2026-10-12" }))).toEqual(["a", "d"]);
  });

  it("leaves an empty end open", () => {
    expect(ids(filterSavedCards(CARDS, { topic: null, from: "2026-10-09", to: "" }))).toEqual(["a", "c", "d"]);
    expect(ids(filterSavedCards(CARDS, { topic: null, from: "", to: "2026-10-09" }))).toEqual(["b", "c"]);
  });

  it("combines topic and dates", () => {
    expect(ids(filterSavedCards(CARDS, { topic: "Tech/AI", from: "2026-10-10", to: "" }))).toEqual(["a"]);
  });

  it("matches nothing when From is after To", () => {
    expect(filterSavedCards(CARDS, { topic: null, from: "2026-10-12", to: "2026-10-03" })).toEqual([]);
  });

  it("never matches an undated card against a date bound", () => {
    const undated = saved("x", "Football", "");
    expect(filterSavedCards([undated], NO_SAVED_FILTER)).toEqual([undated]);
    expect(filterSavedCards([undated], { topic: null, from: "2026-01-01", to: "" })).toEqual([]);
    expect(filterSavedCards([undated], { topic: null, from: "", to: "2099-01-01" })).toEqual([]);
  });
});

describe("formatSavedDate", () => {
  it("formats the calendar day itself, whatever the runtime's zone", () => {
    expect(formatSavedDate("2026-10-12")).toBe("Oct 12, 2026");
    expect(formatSavedDate("2026-01-01")).toBe("Jan 1, 2026");
  });
});
