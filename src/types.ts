// Single runtime source of truth for the curated topic/source lists — the
// onboarding multi-select, its zod validation, and FEEDS all read from
// these arrays instead of the type system silently drifting from what's
// actually selectable.
export const TOPICS = [
  "Tech/AI",
  "US Politics",
  "Morocco Politics",
  "French Politics",
  "Geopolitics",
  "Morocco",
  "Morocco Finance",
  "US Finance",
  "World Finance",
  "European Football",
  "Basketball",
  "Tennis",
  "American Football",
] as const;
export type Topic = (typeof TOPICS)[number];

export const SOURCES = [
  "NYT",
  "BBC",
  "TechCrunch",
  "The Verge",
  "Ars Technica",
  "Engadget",
  "Wired",
  "ZDNet",
  "The Hill",
  "Politico",
  "Axios",
  "Hespress (EN)",
  "Hespress (FR)",
  "Le360",
  "Le Monde",
  "Le Figaro",
  "France24",
  "RFI (EN)",
  "RFI (FR)",
  "The Guardian",
  "Al Jazeera",
  "DW",
  "The North Africa Post",
  "Medias24",
  "Challenge.ma",
  "Le Boursier",
  "CNBC",
  "MarketWatch",
  "Yahoo Finance",
  "Bloomberg",
  "Financial Times",
  "The Economist",
  "Sky Sports",
  "ESPN",
  "Football Italia",
  "Marca",
  "RMC Sport",
  "Kicker",
  "Transfermarkt",
  "The Athletic",
  "Yahoo Sports",
  "CBS Sports",
  "RotoWire",
  "Hoops Rumors",
  "Tennis365",
  "Tennis Majors",
  "UbiTennis",
  "Pro Football Talk",
] as const;
export type Source = (typeof SOURCES)[number];

export interface Article {
  title: string;
  snippet: string;
  url: string;
  source: Source;
  topic: Topic;
  publishedAt: string;
}

export interface Cluster {
  topic: Topic;
  articles: Article[];
}

export interface Card {
  id: string;
  topic: Topic;
  shortSummary: string;
  /**
   * Null until the first time a user expands the card; generated once by
   * generateExpandedReport() and cached on the row from then on. Includes
   * snippet (not just title/url/source) so a lazy report written days
   * after the original cluster is gone from memory still has real source
   * text to work from, without re-fetching source URLs.
   */
  expandedReport: string | null;
  sources: Pick<Article, "title" | "url" | "source" | "snippet">[];
  /** Most recent publishedAt across the cluster's source articles. */
  publishedAt: string;
  /**
   * When this card's generation run persisted it — distinct from
   * publishedAt (source-article recency). Every card from the same
   * same-day run shares an identical value (see persist_generated_cards),
   * which is what lets the feed draw a divider between runs.
   */
  generatedAt: string;
  bookmarked: boolean;
  /**
   * 1-5, graded by triage relative to this card's own topic's typical-day
   * baseline (same independence philosophy as the old boolean `notable`
   * gate, just more granular). Drives topic-page box sizing.
   */
  severity: number;
  /**
   * 1-6 if this card is one of today's front-page picks, null otherwise.
   * Set by rank.ts's cross-topic ranking pass, which re-runs against the
   * full cumulative pool of today's cards on every digest generation — so
   * this can change (including being cleared back to null) on a later run
   * of the same day, not just assigned once.
   */
  frontPageRank: number | null;
}

export interface Digest {
  id: string;
  date: string;
  /** Null if this digest's first generation run hasn't completed successfully yet. */
  lastGeneratedAt: string | null;
  cards: Card[];
}
