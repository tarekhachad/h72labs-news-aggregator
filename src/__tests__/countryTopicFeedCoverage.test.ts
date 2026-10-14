import { describe, expect, it } from "vitest";
import { planUnitFeeds, MAX_FEEDS_PER_TOPIC } from "@/lib/ingest";
import { COUNTRIES_TOPIC } from "@/config/countries";

// The six single-country topics, and what a reader moved to the topic's
// country actually reads. A digest reads at most six feeds per unit, in the
// unit's own order, so this compares what each side reads with no preferred
// outlets: the outlets the topic read, against what planUnitFeeds plans for
// the country. The countries carry their outlets' general news feeds, so even
// a kept outlet now comes through its national section rather than its
// politics or business one; only French Politics' RFI (EN) and Le Monde feeds
// are the very same feed. Losing the politics- and finance-specific outlets
// was accepted when the topics were removed.
const RETIRED: { topic: string; country: string; read: string[]; keeps: string[]; loses: string[] }[] = [
  {
    topic: "US Politics",
    country: "United States",
    read: ["The Guardian", "The Hill", "PBS NewsHour", "NPR", "CBS News", "NBC News"],
    keeps: ["The Guardian", "PBS NewsHour", "NPR", "NBC News"],
    loses: ["The Hill", "CBS News"],
  },
  {
    topic: "US Finance",
    country: "United States",
    read: ["Bloomberg", "NPR", "NYT", "Fortune", "CNBC", "CBS News"],
    keeps: ["NPR", "NYT"],
    loses: ["Bloomberg", "Fortune", "CNBC", "CBS News"],
  },
  {
    topic: "UK Politics",
    country: "United Kingdom",
    read: ["The Guardian", "Sky News", "BBC", "The Economist"],
    keeps: ["The Guardian", "Sky News", "BBC"],
    loses: ["The Economist"],
  },
  {
    topic: "French Politics",
    country: "France",
    read: ["RFI (EN)", "France24", "RFI (FR)", "Le Monde", "BFM TV", "Le Figaro"],
    keeps: ["RFI (EN)", "Le Monde", "BFM TV", "Le Figaro"],
    loses: ["France24", "RFI (FR)"],
  },
  {
    topic: "Morocco Politics",
    country: "Morocco",
    read: ["Hespress (EN)", "Hespress (FR)", "TelQuel"],
    keeps: ["Hespress (EN)", "Hespress (FR)", "TelQuel"],
    loses: [],
  },
  {
    topic: "Morocco Finance",
    country: "Morocco",
    read: ["Hespress (EN)", "The North Africa Post", "Hespress (FR)", "TelQuel"],
    keeps: ["Hespress (EN)", "The North Africa Post", "Hespress (FR)", "TelQuel"],
    loses: [],
  },
];

const countryReads = (country: string) =>
  planUnitFeeds([{ topic: COUNTRIES_TOPIC, subtopic: country }], []).map((feed) => feed.source as string);

describe("what a reader moved from a single-country topic reads in its country", () => {
  it.each(RETIRED)("$topic → $country keeps $keeps and loses $loses", ({ country, read, keeps, loses }) => {
    const reads = countryReads(country);
    expect(reads.length).toBeLessThanOrEqual(MAX_FEEDS_PER_TOPIC);
    expect(read.filter((outlet) => reads.includes(outlet))).toEqual(keeps);
    expect(read.filter((outlet) => !reads.includes(outlet))).toEqual(loses);
  });

  it("reads these outlets for each country, with no preferred outlets", () => {
    expect(countryReads("United States")).toEqual(["The Guardian", "PBS NewsHour", "NPR", "NBC News", "LA Times", "NYT"]);
    expect(countryReads("United Kingdom")).toEqual(["The Guardian", "Daily Mirror", "Channel 4 News", "Sky News", "BBC", "Evening Standard"]);
    expect(countryReads("France")).toEqual(["The Guardian", "RFI (EN)", "The Local France", "Le Monde", "Le Figaro", "BFM TV"]);
    expect(countryReads("Morocco")).toEqual(["Hespress (EN)", "The North Africa Post", "AllAfrica", "Hespress (FR)", "TelQuel", "Le Desk"]);
  });
});
