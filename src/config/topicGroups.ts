import type { Topic } from "@/types";

/**
 * The six groups the topic grid shows, in the order and with the names of
 * docs/(C) SOURCE_CATALOG.md's "Topics and their feeds". Countries is in no
 * group: it is never picked as a topic, only through its countries.
 * src/config/__tests__/topicGroups.test.ts holds this to the catalog.
 */
export const TOPIC_GROUPS: readonly { name: string; topics: readonly Topic[] }[] = [
  {
    name: "Technology and science",
    topics: [
      "Tech/AI",
      "Cybersecurity",
      "Consumer Tech & Gadgets",
      "Gaming",
      "Space",
      "Science",
      "Climate & Environment",
      "Energy Transition & Renewables",
      "Health & Medicine",
      "Biotech & Pharma",
    ],
  },
  {
    name: "Politics and world",
    topics: [
      "US Politics",
      "Morocco Politics",
      "French Politics",
      "Geopolitics",
      "UK Politics",
      "European Union",
      "Middle East",
      "Africa",
      "Asia-Pacific",
      "Latin America",
      "Elections",
      "Immigration",
      "Defense & Security",
      "Human Rights",
    ],
  },
  {
    name: "Business and economy",
    topics: [
      "Morocco Finance",
      "US Finance",
      "World Finance",
      "Economy",
      "Markets & Investing",
      "Personal Finance",
      "Real Estate",
      "Energy & Oil",
      "Crypto",
      "Banking",
      "Retail & Consumer",
      "Automotive",
    ],
  },
  {
    name: "Sports",
    topics: [
      "Football",
      "Basketball",
      "Tennis",
      "American Football",
      "Formula 1",
      "Cricket",
      "Rugby",
      "Golf",
      "Boxing & MMA",
      "Cycling",
      "Baseball",
      "Olympics & Athletics",
    ],
  },
  {
    name: "Culture and life",
    topics: [
      "Film & TV",
      "Music",
      "Books",
      "Art & Design",
      "Architecture",
      "Food & Drink",
      "Travel",
      "Fashion",
      "Celebrity & Entertainment",
      "Education",
      "Religion",
      "Health & Wellness",
    ],
  },
  {
    name: "Society",
    topics: ["Law & Courts", "Crime", "Weather & Natural Disasters", "Media & Journalism"],
  },
];
