import type { Card, Source, Topic } from "@/types";

/**
 * Sample cards for the development-only fixture page. Invented stories, so
 * nothing here is a real outlet's reporting; outlet names are the catalog's
 * so the cards render exactly as real ones do.
 */

const GENERATED_AT = "2026-10-08T07:12:00.000Z";

function card(
  id: string,
  topic: Topic,
  title: string,
  severity: number,
  frontPageRank: number | null,
  outlets: Source[],
  extra: Partial<Card> = {}
): Card {
  return {
    id,
    topic,
    title,
    shortSummary: `${title}. A sample summary of two or three sentences, long enough to show how the card's text wraps and clamps at each size. It names who did what, where, and why it matters to a reader of this topic.`,
    labels: ["Sample", topic.split(" ")[0]],
    expandedReport: null,
    sources: outlets.map((source, i) => ({
      title: `${title} (${source} coverage ${i + 1})`,
      url: `https://example.com/${id}/${i}`,
      source,
      snippet: `Sample snippet ${i + 1} from ${source}.`,
    })),
    publishedAt: "2026-10-08T06:30:00.000Z",
    generatedAt: GENERATED_AT,
    bookmarked: false,
    severity,
    frontPageRank,
    subtopic: null,
    ...extra,
  };
}

export const FIXTURE_TOPICS: Topic[] = ["Geopolitics", "Tech/AI", "Football", "Science", "World Finance", "Countries"] as Topic[];

export const FIXTURE_CARDS: Card[] = [
  card("f-hero", "Geopolitics" as Topic, "Coalition Talks Collapse Hours Before Deadline", 5, 1, ["The Guardian", "BBC", "France24", "DW", "Euronews"] as Source[]),
  card("f-l1", "Tech/AI" as Topic, "Chipmaker Unveils Low-Power AI Accelerator", 4, 2, ["The Verge", "TechCrunch", "The Guardian"] as Source[]),
  card("f-l2", "Football" as Topic, "Late Winner Sends Holders Into the Final", 4, 3, ["BBC", "The Guardian"] as Source[]),
  card("f-s1", "Science" as Topic, "Ice Cores Push Back the Date of an Ancient Thaw", 3, 4, ["Phys.org"] as Source[]),
  card("f-s2", "World Finance" as Topic, "Bond Yields Ease as Inflation Cools", 3, 5, ["Bloomberg", "Financial Times"] as Source[]),
  card("f-s3", "Countries" as Topic, "Parliament Passes Revised Budget After Long Night", 3, 6, ["Le Monde", "France24", "RFI (EN)", "The Local France"] as Source[], { subtopic: "France" }),
  card("f-t1", "Tech/AI" as Topic, "Open-Source Model Tops a Coding Benchmark", 3, null, ["The Verge"] as Source[]),
  card("f-t2", "Tech/AI" as Topic, "Regulator Opens Inquiry Into App Store Fees", 2, null, ["The Guardian", "NBC News"] as Source[]),
  card("f-t3", "Tech/AI" as Topic, "Satellite Startup Raises Funds for Direct-to-Phone Service", 2, null, ["TechCrunch"] as Source[]),
  card("f-t4", "Tech/AI" as Topic, "University Lab Shows Battery That Charges in Minutes", 2, null, ["The Verge", "TechCrunch"] as Source[]),
];
