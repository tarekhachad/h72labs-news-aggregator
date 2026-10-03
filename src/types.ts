// Single runtime source of truth for the curated topic/source lists — the
// onboarding multi-select, its zod validation, and FEEDS all read from
// these arrays instead of the type system silently drifting from what's
// actually selectable.
export const TOPICS = [
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
  "US Politics",
  "Morocco Politics",
  "French Politics",
  "Geopolitics",
  "Morocco",
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
  "Law & Courts",
  "Crime",
  "Weather & Natural Disasters",
  "Media & Journalism",
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
  "The Hill",
  "Politico",
  "Hespress (EN)",
  "Hespress (FR)",
  "Le Monde",
  "Le Figaro",
  "France24",
  "RFI (EN)",
  "RFI (FR)",
  "The Guardian",
  "Al Jazeera",
  "DW",
  "The North Africa Post",
  "Challenge.ma",
  "CNBC",
  "MarketWatch",
  "Bloomberg",
  "Financial Times",
  "The Economist",
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
  "IEEE Spectrum",
  "MIT Technology Review",
  "BleepingComputer",
  "The Record",
  "Dark Reading",
  "9to5Mac",
  "Tom's Hardware",
  "Android Authority",
  "IGN",
  "Kotaku",
  "PC Gamer",
  "SpaceNews",
  "Phys.org",
  "ScienceDaily",
  "NPR",
  "Scientific American",
  "Science (AAAS)",
  "Inside Climate News",
  "Grist",
  "Carbon Brief",
  "CleanTechnica",
  "Canary Media",
  "Electrek",
  "InsideEVs",
  "CBS News",
  "STAT News",
  "Endpoints News",
  "PBS NewsHour",
  "NBC News",
  "LA Times",
  "ABC News",
  "TelQuel",
  "BFM TV",
  "Euronews",
  "Sky News",
  "The Diplomat",
  "Foreign Policy",
  "Yabiladi",
  "Politico Europe",
  "Mail & Guardian",
  "Premium Times (Nigeria)",
  "AllAfrica",
  "Daily Maverick",
  "The East African",
  "Nation (Kenya)",
  "Le Monde Afrique",
  "South China Morning Post",
  "Times of India",
  "The Hindu",
  "Channel NewsAsia",
  "Japan Times",
  "MercoPress",
  "Buenos Aires Times",
  "InfoMigrants",
  "War on the Rocks",
  "The War Zone",
  "Breaking Defense",
  "Defense News",
  "Human Rights Watch",
  "Amnesty International",
  "Fortune",
  "Forbes",
  "HousingWire",
  "OilPrice.com",
  "Rigzone",
  "Cointelegraph",
  "CoinDesk",
  "The Block",
  "Banking Dive",
  "Retail Dive",
  "WWD",
  "Autocar",
  "Motor1",
  "Car and Driver",
  "Hesport",
  "L'Équipe",
  "Motorsport.com",
  "Autosport",
  "The Race",
  "ESPNcricinfo",
  "RugbyPass",
  "MMA Fighting",
  "Cyclingnews",
  "MLB Trade Rumors",
  "Deadline",
  "Variety",
  "IndieWire",
  "The Hollywood Reporter",
  "NME",
  "Rolling Stone",
  "Pitchfork",
  "Billboard",
  "Literary Hub",
  "Dezeen",
  "Designboom",
  "The Art Newspaper",
  "ARTnews",
  "ArchDaily",
  "Eater",
  "Skift",
  "Condé Nast Traveler",
  "Vogue",
  "Inside Higher Ed",
  "Religion News Service",
  "Lawfare",
  "The Marshall Project",
  "Nieman Lab",
  "Poynter",
  "Press Gazette",
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
  /** Short headline (5-8 words), written by writeCard.ts alongside shortSummary. Empty string for pre-5.5 rows (no migration backfill). */
  title: string;
  shortSummary: string;
  /** 1-2 free-form, LLM-generated tags — a more specific angle on the story than topic alone. Empty array for pre-5.5 rows. */
  labels: string[];
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
   * which is what lets the feed identify the latest run and badge its
   * cards as New (see newRun.ts).
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
