import type { Source } from "@/types";

/**
 * The Countries topic: a reader picks countries inside it, and each picked
 * country is its own reading unit (src/lib/readingUnits.ts), with its own feed
 * slots and card limit. Only a country with at least 3 live-verified feeds is
 * offered, the same rule as topics.
 */
export const COUNTRIES_TOPIC = "Countries" as const;

/** Offered countries, in the order the picker lists them and a digest reads them. */
export const COUNTRIES: readonly string[] = [];

/**
 * Verified RSS feeds per country, strongest first: a digest fills a country's
 * feed slots in this key order after the reader's preferred outlets. Every
 * URL meets the bar in src/config/feeds.ts's header and
 * scripts/verify-feeds.mts.
 */
export const COUNTRY_FEEDS: Readonly<Record<string, Partial<Record<Source, string>>>> = {};

/** URL-safe form of a country name, for the Countries page filter. */
export function countryToSlug(country: string): string {
  return country
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The offered country a slug names, or null. */
export function slugToCountry(slug: string): string | null {
  return COUNTRIES.find((country) => countryToSlug(country) === slug) ?? null;
}
