import type { Source, Topic } from "@/types";

// The duplicate groups found in the digest f6b263f5 (61 cards,
// about 1 in 8 a duplicate), as triage's new English event sentences.
//
// Those sentences do not exist yet: the field ships with this change. Each one
// below is written the way the new triage instruction asks for (one plain
// English sentence, at most about 25 words, who did what, where, in English
// even when the articles were French), from the outlets and the event the
// roadmap's evidence names. The details (dates, counts) are illustrative, not
// quotes from those articles.
//
// `mustMerge` groups are one real-world event each and have to end up as one
// card. `mustNotMerge` pairs are Tarek's "keep separate" ruling:
// related angles on one situation, never merged. `background` is unrelated
// news from the same kind of day, so the thresholds are checked against
// ordinary pairs too, not only against the hard cases.

export interface FixtureCluster {
  /** Stable name used in test output. */
  id: string;
  topic: Topic;
  subtopic?: string;
  source: Source;
  /** The language the outlet published in; the sentence is always English. */
  language: "en" | "fr";
  event: string;
}

export const MUST_MERGE: FixtureCluster[][] = [
  // England 7–0 Croatia, ESPN in both clusters.
  [
    {
      id: "england-espn-a",
      topic: "Football",
      source: "ESPN",
      language: "en",
      event: "England beat Croatia 7–0 at Wembley in a World Cup qualifier, their biggest ever win over Croatia.",
    },
    {
      id: "england-espn-b",
      topic: "Football",
      source: "ESPN",
      language: "en",
      event: "England thrashed Croatia 7-0 in World Cup qualifying at Wembley Stadium in London.",
    },
  ],
  // French school protests: BFM TV and Le Figaro (French) against NPR, RFI
  // and The Local (English).
  [
    {
      id: "schools-bfm",
      topic: "Countries",
      subtopic: "France",
      source: "BFM TV",
      language: "fr",
      event: "Teachers and high school students across France went on strike and marched against the government's education budget cuts.",
    },
    {
      id: "schools-figaro",
      topic: "French Politics",
      source: "Le Figaro",
      language: "fr",
      event: "Thousands of teachers in France walked out of schools nationwide to protest planned cuts to the education budget.",
    },
    {
      id: "schools-npr",
      topic: "Education",
      source: "NPR",
      language: "en",
      event: "Schools across France were disrupted as teachers' unions held a national strike over education spending cuts.",
    },
  ],
  // Russia strikes on Kyiv, The Guardian vs France 24, under two topics.
  [
    {
      id: "kyiv-guardian",
      topic: "Geopolitics",
      source: "The Guardian",
      language: "en",
      event: "Russia launched a large overnight missile and drone attack on Kyiv, killing several civilians and damaging apartment buildings.",
    },
    {
      id: "kyiv-france24",
      topic: "Defense & Security",
      source: "France24",
      language: "en",
      event: "A massive Russian drone and missile strike hit Ukraine's capital Kyiv overnight, killing civilians and cutting power to parts of the city.",
    },
  ],
  // The Morocco coalition, Le Desk's two articles forming two clusters.
  [
    {
      id: "coalition-ledesk-a",
      topic: "Countries",
      subtopic: "Morocco",
      source: "Le Desk",
      language: "fr",
      event: "Leaders of Morocco's three-party governing coalition met in Rabat and agreed to stay together until the 2026 legislative elections.",
    },
    {
      id: "coalition-ledesk-b",
      topic: "Countries",
      subtopic: "Morocco",
      source: "Le Desk",
      language: "fr",
      event: "Morocco's ruling coalition parties met in Rabat to settle their differences and renew their alliance ahead of the 2026 elections.",
    },
  ],
];

export const MUST_NOT_MERGE: [FixtureCluster, FixtureCluster][] = [
  // Brazil's election: two angles on one campaign.
  [
    {
      id: "brazil-deadlocked",
      topic: "Latin America",
      source: "Al Jazeera",
      language: "en",
      event: "Brazil's presidential race is deadlocked, with new polls showing Lula and his main challenger tied weeks before the vote.",
    },
    {
      id: "brazil-trump",
      topic: "Elections",
      source: "The Guardian",
      language: "en",
      event: "Brazil's presidential election has become a referendum on Donald Trump after his tariffs on Brazil and support for Bolsonaro.",
    },
  ],
  // Bond markets across World Finance and Markets: two angles on one sell-off.
  [
    {
      id: "bonds-world-finance",
      topic: "World Finance",
      source: "Financial Times",
      language: "en",
      event: "Government bond yields rose across the US, UK and France as investors worried about mounting public debt.",
    },
    {
      id: "bonds-markets",
      topic: "Markets & Investing",
      source: "Bloomberg",
      language: "en",
      event: "Long-dated US Treasury yields climbed to their highest level in months as traders bet on fewer Federal Reserve rate cuts.",
    },
  ],
];

/** Unrelated stories from the same kind of day, including near-topic ones. */
export const BACKGROUND: FixtureCluster[] = [
  { id: "bg-arsenal", topic: "Football", source: "BBC", language: "en", event: "Arsenal beat Chelsea 2-1 at the Emirates Stadium to go top of the Premier League." },
  { id: "bg-zelensky", topic: "Geopolitics", source: "BBC", language: "en", event: "Ukrainian President Volodymyr Zelensky met European leaders in London to discuss security guarantees for Ukraine." },
  { id: "bg-odesa", topic: "Defense & Security", source: "Al Jazeera", language: "en", event: "Ukrainian drones struck an oil refinery in Russia's Krasnodar region, starting a large fire." },
  { id: "bg-france-budget", topic: "French Politics", source: "Le Monde", language: "fr", event: "France's prime minister survived a no-confidence vote in the National Assembly over the 2027 budget." },
  { id: "bg-morocco-rate", topic: "Morocco Finance", source: "Hespress (FR)", language: "fr", event: "Morocco's central bank, Bank Al-Maghrib, held its key interest rate at 2.25 percent." },
  { id: "bg-fed", topic: "US Finance", source: "CNBC", language: "en", event: "The US Federal Reserve held interest rates steady and signalled one more cut before the end of the year." },
  { id: "bg-openai", topic: "Tech/AI", source: "TechCrunch", language: "en", event: "OpenAI released a new reasoning model and cut prices for developers using its API." },
  { id: "bg-hurricane", topic: "Weather & Natural Disasters", source: "Sky News", language: "en", event: "Hurricane Melissa made landfall in Jamaica as a Category 4 storm, forcing thousands to evacuate." },
  { id: "bg-lula-cop", topic: "Climate & Environment", source: "Sky News", language: "en", event: "Brazil's President Lula opened the COP30 climate summit in Belém, urging rich nations to fund forest protection." },
  { id: "bg-spain-strike", topic: "European Union", source: "Euronews", language: "en", event: "Spanish air traffic controllers went on a 24-hour strike, cancelling hundreds of flights across Spain." },
  { id: "bg-croatia-gov", topic: "European Union", source: "Euronews", language: "en", event: "Croatia's parliament approved a new government led by Prime Minister Andrej Plenković." },
  { id: "bg-nvidia", topic: "Markets & Investing", source: "CNBC", language: "en", event: "Nvidia shares fell 4 percent after the chipmaker forecast slower data centre revenue growth." },
];

/**
 * Different events written in the same pattern. Their sentences score as high
 * as real duplicates, which is why the embedding score never merges anything
 * by itself: every one of these must stay two cards.
 */
export const SAME_PATTERN_DIFFERENT_EVENTS: [FixtureCluster, FixtureCluster][] = [
  [
    { id: "madrid-barcelona", topic: "Football", source: "ESPN", language: "en", event: "Real Madrid beat Barcelona 2-1 in La Liga." },
    { id: "madrid-sevilla", topic: "Football", source: "BBC", language: "en", event: "Real Madrid beat Sevilla 2-1 in La Liga." },
  ],
  [
    { id: "strike-kyiv", topic: "Geopolitics", source: "The Guardian", language: "en", event: "Russia launched a large overnight missile and drone attack on Kyiv, killing several civilians and damaging apartment buildings." },
    { id: "strike-lviv", topic: "Geopolitics", source: "BBC", language: "en", event: "Russia launched a large overnight missile and drone attack on Lviv, damaging energy infrastructure in western Ukraine." },
  ],
  [
    { id: "strikes-gaza", topic: "Middle East", source: "Al Jazeera", language: "en", event: "Israeli strikes killed at least 30 people in Gaza City on Tuesday, according to local health officials." },
    { id: "strikes-lebanon", topic: "Middle East", source: "BBC", language: "en", event: "Israeli strikes killed at least 12 people in southern Lebanon on Tuesday, according to Lebanese officials." },
  ],
  [
    { id: "england-croatia", topic: "Football", source: "ESPN", language: "en", event: "England beat Croatia 7–0 at Wembley in a World Cup qualifier, their biggest ever win over Croatia." },
    { id: "england-serbia", topic: "Football", source: "BBC", language: "en", event: "England beat Serbia 5–0 in Belgrade in a World Cup qualifier to secure their place at the 2026 finals." },
  ],
  [
    { id: "rates-fed", topic: "US Finance", source: "CNBC", language: "en", event: "The US Federal Reserve held interest rates steady and signalled one more cut before the end of the year." },
    { id: "rates-boe", topic: "World Finance", source: "Financial Times", language: "en", event: "The Bank of England held interest rates at 4 percent and signalled one more cut before the end of the year." },
  ],
];

/** One event worded two ways with few shared words: the lowest-scoring duplicate measured. */
export const REWORDED_SAME_EVENT: [FixtureCluster, FixtureCluster] = [
  { id: "censure-a", topic: "French Politics", source: "Le Monde", language: "fr", event: "France's prime minister survived a no-confidence vote in the National Assembly over the 2027 budget." },
  { id: "censure-b", topic: "Countries", subtopic: "France", source: "France24", language: "en", event: "The French government narrowly survived a censure motion in parliament over its budget plans." },
];

/**
 * Cosine similarity of each pair's event sentences, measured with the vendored
 * all-MiniLM-L6-v2 model (mean pooling, normalised, as embed() does). Every
 * fixture pair not listed here measured below 0.40. Tests pin these instead of
 * loading the model; mergeDuplicates.realModel.test.ts re-measures them when
 * MERGE_REAL_MODEL=1.
 */
export const MEASURED_SCORES: Record<string, number> = {
  "coalition-ledesk-a|coalition-ledesk-b": 0.843,
  "kyiv-guardian|kyiv-france24": 0.794,
  "england-espn-a|england-espn-b": 0.79,
  "schools-bfm|schools-npr": 0.779,
  "schools-bfm|schools-figaro": 0.759,
  "schools-figaro|schools-npr": 0.656,
  "bonds-world-finance|bonds-markets": 0.565,
  "kyiv-france24|bg-odesa": 0.503,
  "kyiv-guardian|bg-odesa": 0.457,
  "bonds-markets|bg-fed": 0.45,
  "brazil-deadlocked|brazil-trump": 0.427,
  "madrid-barcelona|madrid-sevilla": 0.935,
  "strike-kyiv|strike-lviv": 0.826,
  "strikes-gaza|strikes-lebanon": 0.782,
  "england-croatia|england-serbia": 0.728,
  "rates-fed|rates-boe": 0.71,
  "censure-a|censure-b": 0.599,
};

/** Every pair the tests treat as the same real-world event. */
export function sameEvent(a: string, b: string): boolean {
  if (a === b) return true;
  if (MUST_MERGE.some((group) => group.some((c) => c.id === a) && group.some((c) => c.id === b))) return true;
  const [x, y] = REWORDED_SAME_EVENT;
  return (a === x.id && b === y.id) || (a === y.id && b === x.id);
}
