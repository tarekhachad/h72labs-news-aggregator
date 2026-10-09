import { SOURCES, type Source, type Topic } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";

/** The topics and countries one outlet has a feed in, in catalog order. */
export interface OutletCoverage {
  topics: readonly Topic[];
  countries: readonly string[];
}

/** Every offered outlet's coverage. Names only: never a feed URL. */
export type SourceCoverage = Readonly<Record<Source, OutletCoverage>>;

/**
 * Which topics and countries each outlet publishes in, from the feed tables.
 *
 * The tables come in as arguments rather than imports: the outlets picker
 * runs in the browser and uses the helpers below, so importing FEEDS or
 * COUNTRY_FEEDS here would ship every feed URL with it. A server page builds
 * the map and hands the browser only the result.
 */
export function buildSourceCoverage(
  topicFeeds: Readonly<Partial<Record<Topic, Partial<Record<Source, string>>>>>,
  countryFeeds: Readonly<Record<string, Partial<Record<Source, string>>>>
): SourceCoverage {
  const coverage = Object.fromEntries(
    SOURCES.map((source) => [source, { topics: [] as Topic[], countries: [] as string[] }])
  ) as Record<Source, { topics: Topic[]; countries: string[] }>;
  for (const [topic, feeds] of Object.entries(topicFeeds) as [Topic, Partial<Record<Source, string>>][]) {
    if (topic === COUNTRIES_TOPIC) continue;
    for (const source of Object.keys(feeds ?? {}) as Source[]) coverage[source]?.topics.push(topic);
  }
  for (const country of COUNTRIES) {
    for (const source of Object.keys(countryFeeds[country] ?? {}) as Source[]) coverage[source]?.countries.push(country);
  }
  return coverage;
}

/** The reader's picks an outlet covers: the topics and countries it has a feed in. */
export function coveredPicks(
  coverage: SourceCoverage,
  source: Source,
  topics: readonly Topic[],
  countries: readonly string[]
): { topics: Topic[]; countries: string[] } {
  const own = coverage[source];
  if (!own) return { topics: [], countries: [] };
  const pickedTopics = new Set(topics);
  const pickedCountries = new Set(countries);
  return {
    topics: own.topics.filter((topic) => pickedTopics.has(topic)),
    countries: own.countries.filter((country) => pickedCountries.has(country)),
  };
}

export const COVERS_TOPICS = "Covers your topics";
export const COVERS_COUNTRIES = "Covers your countries";
export const EVERYTHING_ELSE = "Everything else";
/**
 * The "everything else" group for an outlet with country feeds for no
 * country or for several. One with feeds for exactly one country sits under
 * that country, whatever topic feeds it also has (NYT under United States).
 */
export const INTERNATIONAL = "International";

export interface SourceGroup {
  label: string;
  /** The heading over a run of groups; only "Everything else" has one. */
  section?: string;
  items: Source[];
}

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

/**
 * The outlets picker's groups for the reader's current picks, each outlet in
 * exactly one: "Covers your topics" (most of the reader's topics first),
 * "Covers your countries", then everything else under the one country it
 * publishes for, or "International". A group with no outlets is left out.
 */
export function groupSourcesByCoverage(
  coverage: SourceCoverage,
  topics: readonly Topic[],
  countries: readonly string[]
): SourceGroup[] {
  const topicCount = new Map<Source, number>();
  const byCountries: Source[] = [];
  const international: Source[] = [];
  const byHomeCountry = new Map<string, Source[]>();

  for (const source of SOURCES) {
    const covered = coveredPicks(coverage, source, topics, countries);
    if (covered.topics.length > 0) {
      topicCount.set(source, covered.topics.length);
    } else if (covered.countries.length > 0) {
      byCountries.push(source);
    } else {
      const own = coverage[source]?.countries ?? [];
      if (own.length === 1) byHomeCountry.set(own[0], [...(byHomeCountry.get(own[0]) ?? []), source]);
      else international.push(source);
    }
  }

  const byTopics = [...topicCount.keys()].sort((a, b) => topicCount.get(b)! - topicCount.get(a)! || byName(a, b));
  const groups: SourceGroup[] = [
    { label: COVERS_TOPICS, items: byTopics },
    { label: COVERS_COUNTRIES, items: byCountries.sort(byName) },
    { label: INTERNATIONAL, section: EVERYTHING_ELSE, items: international.sort(byName) },
    ...COUNTRIES.map((country) => ({
      label: country,
      section: EVERYTHING_ELSE,
      items: (byHomeCountry.get(country) ?? []).sort(byName),
    })),
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** "6 of your topics", "1 of your countries", "6 of your topics and 1 of your countries", or null for none. */
function coverageCounts(topicCount: number, countryCount: number): string | null {
  const parts = [
    topicCount > 0 ? `${topicCount} of your topics` : null,
    countryCount > 0 ? `${countryCount} of your countries` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" and ") : null;
}

/** The review step's line for a picked outlet: "BBC covers 6 of your topics", "Kicker covers none". */
export function coverageSentence(
  coverage: SourceCoverage,
  source: Source,
  topics: readonly Topic[],
  countries: readonly string[]
): string {
  const covered = coveredPicks(coverage, source, topics, countries);
  return `${source} covers ${coverageCounts(covered.topics.length, covered.countries.length) ?? "none"}`;
}

/** The muted detail after an outlet's name in the picker: how many of the reader's topics, or which of their countries. */
export function coverageDetail(
  coverage: SourceCoverage,
  source: Source,
  topics: readonly Topic[],
  countries: readonly string[]
): string | null {
  const covered = coveredPicks(coverage, source, topics, countries);
  if (covered.topics.length > 0) return `${covered.topics.length} of your topics`;
  if (covered.countries.length > 0) return covered.countries.join(", ");
  return null;
}
