import { TOPICS, type Topic } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { countReadingUnits } from "@/lib/readingUnits";

/** Every topic a reader picks directly. Countries isn't one: the server saves it exactly when a country is picked (ProfileInput in src/lib/profile.ts). */
export const PICKABLE_TOPICS = TOPICS.filter((topic) => topic !== COUNTRIES_TOPIC);

/**
 * The reading units the picks make, counted as the server will save them:
 * with the Countries topic added when there are countries, so
 * countReadingUnits stays the one counting rule.
 */
export function unitsOf(topics: readonly Topic[], countries: readonly string[]): number {
  return countReadingUnits(countries.length > 0 ? [...topics, COUNTRIES_TOPIC] : topics, countries);
}

/** "7 topics and 2 countries", "1 topic", "3 topics". */
export function picksPhrase(topicCount: number, countryCount: number): string {
  const topics = `${topicCount} ${topicCount === 1 ? "topic" : "topics"}`;
  if (countryCount === 0) return topics;
  return `${topics} and ${countryCount} ${countryCount === 1 ? "country" : "countries"}`;
}

/** Why saving or moving on is blocked below the minimum, e.g. "Pick at least 2 more topics to continue." */
export function belowMinimumReason(units: number, min: number, toWhat: "continue" | "save"): string {
  const more = min - units;
  return `Pick at least ${more} more ${more === 1 ? "topic" : "topics"} to ${toWhat}. Each country counts as one.`;
}
