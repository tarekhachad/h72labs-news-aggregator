import { TOPICS, type Topic } from "@/types";

/**
 * Explicit lookup table, not a generic slugify() — several Topic values
 * have spaces or slashes ("Tech/AI", "US Finance") and a generic slugifier
 * would be one more place topic-name changes could silently drift from the
 * URL scheme. This table is the single source of truth for the mapping.
 */
const TOPIC_TO_SLUG: Record<Topic, string> = {
  "Tech/AI": "tech-ai",
  Cybersecurity: "cybersecurity",
  "Consumer Tech & Gadgets": "consumer-tech-gadgets",
  Gaming: "gaming",
  Space: "space",
  Science: "science",
  "Climate & Environment": "climate-environment",
  "Energy Transition & Renewables": "energy-transition-renewables",
  "Health & Medicine": "health-medicine",
  "Biotech & Pharma": "biotech-pharma",
  "US Politics": "us-politics",
  "Morocco Politics": "morocco-politics",
  "French Politics": "french-politics",
  Geopolitics: "geopolitics",
  Morocco: "morocco",
  "UK Politics": "uk-politics",
  "European Union": "european-union",
  "Middle East": "middle-east",
  Africa: "africa",
  "Asia-Pacific": "asia-pacific",
  "Latin America": "latin-america",
  Elections: "elections",
  Immigration: "immigration",
  "Defense & Security": "defense-security",
  "Human Rights": "human-rights",
  "Morocco Finance": "morocco-finance",
  "US Finance": "us-finance",
  "World Finance": "world-finance",
  Economy: "economy",
  "Markets & Investing": "markets-investing",
  "Personal Finance": "personal-finance",
  "Real Estate": "real-estate",
  "Energy & Oil": "energy-oil",
  Crypto: "crypto",
  Banking: "banking",
  "Retail & Consumer": "retail-consumer",
  Automotive: "automotive",
  Football: "football",
  Basketball: "basketball",
  Tennis: "tennis",
  "American Football": "american-football",
  "Formula 1": "formula-1",
  Cricket: "cricket",
  Rugby: "rugby",
  Golf: "golf",
  "Boxing & MMA": "boxing-mma",
  Cycling: "cycling",
  Baseball: "baseball",
  "Olympics & Athletics": "olympics-athletics",
  "Film & TV": "film-tv",
  Music: "music",
  Books: "books",
  "Art & Design": "art-design",
  Architecture: "architecture",
  "Food & Drink": "food-drink",
  Travel: "travel",
  Fashion: "fashion",
  "Celebrity & Entertainment": "celebrity-entertainment",
  Education: "education",
  Religion: "religion",
  "Health & Wellness": "health-wellness",
  "Law & Courts": "law-courts",
  Crime: "crime",
  "Weather & Natural Disasters": "weather-natural-disasters",
  "Media & Journalism": "media-journalism",
};

const SLUG_TO_TOPIC: Record<string, Topic> = Object.fromEntries(
  TOPICS.map((topic) => [TOPIC_TO_SLUG[topic], topic])
);

export function topicToSlug(topic: Topic): string {
  return TOPIC_TO_SLUG[topic];
}

/** Returns null for an unrecognized slug — callers redirect rather than throw. */
export function slugToTopic(slug: string): Topic | null {
  return SLUG_TO_TOPIC[slug] ?? null;
}
