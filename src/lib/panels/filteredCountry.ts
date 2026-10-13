import type { Card, Topic } from "@/types";
import { COUNTRIES_TOPIC, countryToSlug, slugToCountry } from "@/config/countryNames";

/**
 * The country the Countries page is filtered to, as one of COUNTRIES, or
 * null when the page shows every country. Same rule as TopicPage's
 * filterCountryCards (a test holds the two together): the slug must name a
 * country among the day's cards. The name comes from COUNTRIES, never from
 * the query string itself.
 */
export function filteredCountry(topic: Topic, cards: readonly Card[], countrySlug: string | undefined): string | null {
  if (topic !== COUNTRIES_TOPIC || countrySlug === undefined) return null;
  const onPage = cards.some((card) => card.subtopic && countryToSlug(card.subtopic) === countrySlug);
  return onPage ? slugToCountry(countrySlug) : null;
}
