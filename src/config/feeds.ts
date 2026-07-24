import type { Source, Topic } from "@/types";

/**
 * Curated RSS feed per (topic, source). Not every source publishes a feed
 * for every topic (e.g. TechCrunch has no geopolitics desk), so this is a
 * partial map rather than a full grid.
 */
export const FEEDS: Record<Topic, Partial<Record<Source, string>>> = {
  "Tech/AI": {
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
    BBC: "http://feeds.bbci.co.uk/news/technology/rss.xml",
    TechCrunch: "https://techcrunch.com/feed/",
  },
  Geopolitics: {
    NYT: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    BBC: "http://feeds.bbci.co.uk/news/world/rss.xml",
  },
};
