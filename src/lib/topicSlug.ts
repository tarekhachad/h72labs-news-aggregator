import { TOPICS, type Topic } from "@/types";

/**
 * Explicit lookup table, not a generic slugify() — several Topic values
 * have spaces or slashes ("Tech/AI", "US Finance") and a generic slugifier
 * would be one more place topic-name changes could silently drift from the
 * URL scheme. This table is the single source of truth for the mapping.
 */
const TOPIC_TO_SLUG: Record<Topic, string> = {
  "Tech/AI": "tech-ai",
  "US Politics": "us-politics",
  "Morocco Politics": "morocco-politics",
  "French Politics": "french-politics",
  Geopolitics: "geopolitics",
  Morocco: "morocco",
  "Morocco Finance": "morocco-finance",
  "US Finance": "us-finance",
  "World Finance": "world-finance",
  "European Football": "european-football",
  Basketball: "basketball",
  Tennis: "tennis",
  "American Football": "american-football",
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
