import { describe, it, expect } from "vitest";
import { newRunCardIds } from "@/lib/newRun";
import type { Card } from "@/types";

function card(id: string, generatedAt: string): Card {
  return {
    id,
    topic: "Tech/AI",
    title: `Title ${id}`,
    shortSummary: `Summary ${id}`,
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-08-12T09:00:00.000Z",
    generatedAt,
    bookmarked: false,
    severity: 3,
    frontPageRank: null,
  };
}

const RUN_1 = "2026-08-12T08:00:00.000Z";
const RUN_2 = "2026-08-12T09:15:00.000Z";
const RUN_3 = "2026-08-12T11:30:00.000Z";

describe("newRunCardIds", () => {
  it("returns an empty set for no cards", () => {
    expect(newRunCardIds([])).toEqual(new Set());
  });

  it("returns an empty set when every card came from the same run", () => {
    // The headline rule, and the common case: an ordinary single-generation
    // day must badge nothing at all. "New" is only meaningful relative to
    // something older on the same page.
    const cards = [card("a", RUN_1), card("b", RUN_1), card("c", RUN_1)];
    expect(newRunCardIds(cards)).toEqual(new Set());
  });

  it("returns only the later run's ids when a page spans two runs", () => {
    const cards = [card("old-1", RUN_1), card("new-1", RUN_2), card("old-2", RUN_1)];
    expect(newRunCardIds(cards)).toEqual(new Set(["new-1"]));
  });

  it("badges only the newest run when a page spans three, ignoring the middle one", () => {
    const cards = [
      card("first", RUN_1),
      card("middle", RUN_2),
      card("latest-a", RUN_3),
      card("latest-b", RUN_3),
    ];
    expect(newRunCardIds(cards)).toEqual(new Set(["latest-a", "latest-b"]));
  });

  it("treats the two serializer formats for one instant as a single run", () => {
    // generatedAt arrives as PostgREST's timestamptz rendering for anything
    // read from the database, and as route.ts's own toISOString() for cards
    // streamed live from a generation in progress. Same moment, different
    // strings — a naive === grouping would see two runs here and wrongly
    // badge half the page.
    const cards = [
      card("from-db", "2026-08-12T10:00:00.123+00:00"),
      card("from-stream", "2026-08-12T10:00:00.123Z"),
    ];
    expect(newRunCardIds(cards)).toEqual(new Set());
  });

  it("picks the genuinely latest instant, not the largest string", () => {
    // "2026-08-12T09:00:00+02:00" is 07:00 UTC — earlier than
    // "2026-08-12T08:00:00Z" despite sorting after it lexicographically.
    // Guards against a future "simplify this to Math.max over strings".
    const cards = [
      card("actually-later", "2026-08-12T08:00:00.000Z"),
      card("looks-later", "2026-08-12T09:00:00.000+02:00"),
    ];
    expect(newRunCardIds(cards)).toEqual(new Set(["actually-later"]));
  });

  it("is independent of input order", () => {
    const cards = [card("old", RUN_1), card("new", RUN_2)];
    const reversed = [...cards].reverse();
    expect(newRunCardIds(reversed)).toEqual(newRunCardIds(cards));
  });

  it("ignores an unparseable generatedAt rather than treating it as its own run", () => {
    // One malformed row must not manufacture a second run and badge the
    // whole page.
    const cards = [card("good-1", RUN_1), card("good-2", RUN_1), card("broken", "not-a-date")];
    expect(newRunCardIds(cards)).toEqual(new Set());
  });

  it("still badges correctly when a malformed row sits alongside two real runs", () => {
    const cards = [card("old", RUN_1), card("new", RUN_2), card("broken", "")];
    expect(newRunCardIds(cards)).toEqual(new Set(["new"]));
  });
});
