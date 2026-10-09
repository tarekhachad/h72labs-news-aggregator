import { describe, expect, it } from "vitest";
import { planUnitFeeds, MAX_FEEDS_PER_TOPIC } from "@/lib/ingest";
import { COUNTRY_FEEDS } from "@/config/countries";
import type { Source } from "@/types";

// The retired Morocco topic's six feeds, and what a reader moved to the
// Morocco country actually gets. The country lists all six, but a digest
// reads at most six feeds per unit in the country's own order, so with no
// preferred outlets Yabiladi and Challenge.ma (its 7th and 8th) give way to
// AllAfrica and Le Desk. That trade was accepted when the topic was retired;
// a reader who prefers either outlet still gets it.
const RETIRED_TOPIC_FEEDS: Record<string, string> = {
  "Hespress (EN)": "https://en.hespress.com/feed",
  "The North Africa Post": "https://northafricapost.com/feed",
  "Hespress (FR)": "https://fr.hespress.com/feed",
  TelQuel: "https://telquel.ma/feed",
  Yabiladi: "https://www.yabiladi.com/rss/news.xml",
  "Challenge.ma": "https://www.challenge.ma/feed",
};

const norm = (url: string) => url.replace(/\/$/, "");
const morocco = [{ topic: "Countries" as const, subtopic: "Morocco" }];

describe("what the Morocco country reads for a reader moved from the retired topic", () => {
  it("lists every one of the topic's feeds in its catalog", () => {
    const catalog = Object.values(COUNTRY_FEEDS.Morocco).map(norm);
    for (const url of Object.values(RETIRED_TOPIC_FEEDS)) expect(catalog).toContain(norm(url));
  });

  it("reads four of them with no preferred outlets, plus AllAfrica and Le Desk", () => {
    const read = planUnitFeeds(morocco, []);
    expect(read).toHaveLength(MAX_FEEDS_PER_TOPIC);
    const urls = read.map((f) => norm(f.url));
    const missing = Object.entries(RETIRED_TOPIC_FEEDS)
      .filter(([, url]) => !urls.includes(norm(url)))
      .map(([source]) => source);
    expect(missing).toEqual(["Yabiladi", "Challenge.ma"]);
    expect(read.map((f) => f.source)).toEqual(expect.arrayContaining(["AllAfrica", "Le Desk"]));
  });

  it("reads Yabiladi and Challenge.ma when the reader prefers them", () => {
    const read = planUnitFeeds(morocco, ["Yabiladi", "Challenge.ma"] as Source[]).map((f) => f.source);
    expect(read).toEqual(expect.arrayContaining(["Yabiladi", "Challenge.ma"]));
  });
});
