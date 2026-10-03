import { TOPICS, type Topic } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";

/**
 * A reading unit is a topic, or one country the reader picked inside
 * Countries. Every per-topic rule works on units: the feed slots, the card
 * limit, triage batching, the 3-to-10 limit and the spend reservation's topic
 * count. The Countries container itself is never a unit, so 6 topics plus 4
 * countries is 10 units.
 */
export interface ReadingUnit {
  topic: Topic;
  /** The country within Countries; null for every other topic. */
  subtopic: string | null;
}

export const MIN_READING_UNITS = 3;
export const MAX_READING_UNITS = 10;

/** How many units a reader's picks make. Countries counts only through its countries. */
export function countReadingUnits(topics: readonly string[], countries: readonly string[]): number {
  const picked = new Set(topics);
  if (!picked.has(COUNTRIES_TOPIC)) return picked.size;
  return picked.size - 1 + new Set(countries).size;
}

/**
 * The units a digest reads, in curated order (TOPICS order, with Countries
 * expanded in place into its countries in COUNTRIES order, unknown country
 * names after them), capped at MAX_READING_UNITS. Countries picked without the
 * Countries topic are ignored.
 */
export function readingUnits(
  topics: readonly Topic[],
  countries: readonly string[]
): { read: ReadingUnit[]; dropped: number } {
  const picked = new Set(topics);
  const ordered = [...picked].sort((a, b) => rank(TOPICS, a) - rank(TOPICS, b));
  const countryUnits = [...new Set(countries)]
    .sort((a, b) => rank(COUNTRIES, a) - rank(COUNTRIES, b))
    .map((country): ReadingUnit => ({ topic: COUNTRIES_TOPIC, subtopic: country }));
  const all: ReadingUnit[] = ordered.flatMap((topic) =>
    topic === COUNTRIES_TOPIC ? countryUnits : [{ topic, subtopic: null }]
  );
  return { read: all.slice(0, MAX_READING_UNITS), dropped: Math.max(0, all.length - MAX_READING_UNITS) };
}

function rank(order: readonly string[], value: string): number {
  const i = order.indexOf(value);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
