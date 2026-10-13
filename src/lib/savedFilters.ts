import type { SavedCard } from "@/lib/bookmarks";

/**
 * The Saved page's filters. Dates are "YYYY-MM-DD" (a card's digest date,
 * the day shown as "From …"), compared as strings, which orders them
 * correctly because the format is fixed-width. An empty string is an open
 * end, matching what an empty <input type="date"> reports.
 */
export interface SavedFilter {
  topic: string | null;
  from: string;
  to: string;
}

export const NO_SAVED_FILTER: SavedFilter = { topic: null, from: "", to: "" };

/** The topics among the saved cards, alphabetical. A Countries card counts as "Countries". */
export function savedTopics(cards: readonly SavedCard[]): string[] {
  return [...new Set(cards.map((card) => card.topic))].sort((a, b) => a.localeCompare(b));
}

/** The earliest and latest digest dates among the cards, or null when none has a date. */
export function savedDateBounds(cards: readonly SavedCard[]): { min: string; max: string } | null {
  const dates = cards.map((card) => card.date).filter(Boolean).sort();
  return dates.length === 0 ? null : { min: dates[0], max: dates[dates.length - 1] };
}

/**
 * The topic actually filtered by. One that no card has any more (its last
 * card was removed) counts as "All", so the page never shows an empty list
 * with no chip left to clear it.
 */
export function activeSavedTopic(cards: readonly SavedCard[], topic: string | null): string | null {
  return topic !== null && cards.some((card) => card.topic === topic) ? topic : null;
}

/** Keeps the cards that match every filter, in their given order. A card without a date never matches a date bound. */
export function filterSavedCards(cards: readonly SavedCard[], filter: SavedFilter): SavedCard[] {
  const topic = activeSavedTopic(cards, filter.topic);
  return cards.filter(
    (card) =>
      (topic === null || card.topic === topic) &&
      (filter.from === "" || (card.date !== "" && card.date >= filter.from)) &&
      (filter.to === "" || (card.date !== "" && card.date <= filter.to))
  );
}

/** "Oct 12, 2026". Fixed locale and UTC so the server and the browser render the same text. */
export function formatSavedDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
