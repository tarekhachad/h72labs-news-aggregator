import { describe, it, expect, beforeEach, vi } from "vitest";
import { SOURCES, type Source, type Topic } from "@/types";

// QA round 3: the planned-feed skip on a synthetic catalog, with overlaps
// shaped like the real catalog's near-identical feed URLs. Feeds that differ
// by a meaningful query value or by path case are different feeds and must
// both be read; a pure spelling difference is one feed and is read once.

const mocks = vi.hoisted(() => ({
  parseURL: vi.fn(),
  feeds: {} as Record<string, Record<string, string>>,
  countryFeeds: {} as Record<string, Record<string, string>>,
}));
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));
vi.mock("@/config/feeds", () => ({ FEEDS: mocks.feeds }));
vi.mock("@/config/countries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/countries")>()),
  COUNTRIES: ["X"],
  COUNTRY_FEEDS: mocks.countryFeeds,
}));

import { ingestUnits, planUnitFeeds } from "@/lib/ingest";
import { COUNTRIES_TOPIC } from "@/config/countries";
import type { ReadingUnit } from "@/lib/readingUnits";

const S = (i: number) => SOURCES[i] as Source;
const TOPIC = "Sports" as Topic;
const units: ReadingUnit[] = [
  { topic: TOPIC, subtopic: null },
  { topic: COUNTRIES_TOPIC, subtopic: "X" },
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const g of [mocks.feeds, mocks.countryFeeds]) for (const k of Object.keys(g)) delete g[k];
  mocks.parseURL.mockImplementation(async (url: string) => ({
    items: [{ title: url, link: `${url}#i`, contentSnippet: "x", isoDate: new Date().toISOString() }],
  }));
});

describe("feed identity on catalog-shaped near-duplicates", () => {
  it("query values and path case distinguish feeds; the second unit reads all of them", () => {
    mocks.feeds[TOPIC] = {
      [S(0)]: "https://www.rotowire.com/rss/news.php?sport=nba",
      [S(1)]: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511",
      [S(2)]: "https://dwh.lequipe.fr/api/edito/rss?path=/Tennis/",
      [S(3)]: "https://site.test/News/feed",
      [S(4)]: "https://www.ft.com/markets?format=rss",
    };
    mocks.countryFeeds.X = {
      [S(5)]: "https://www.rotowire.com/rss/news.php?sport=nfl",
      [S(6)]: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416",
      [S(7)]: "https://dwh.lequipe.fr/api/edito/rss?path=/Rugby/",
      [S(8)]: "https://site.test/news/feed",
      [S(9)]: "https://www.ft.com/banks?format=rss",
    };
    const plan = planUnitFeeds(units);
    expect(plan.filter((f) => f.subtopic === "X").map((f) => f.source)).toEqual([S(5), S(6), S(7), S(8), S(9)]);
    expect(plan).toHaveLength(10);
  });

  it("scheme, www, trailing slash and reordered query are one feed: the second unit skips it and fills from its next feed", () => {
    mocks.feeds[TOPIC] = {
      [S(0)]: "https://www.challenge.ma/feed",
      [S(1)]: "https://a.test/rss?b=2&a=1",
      [S(2)]: "https://b.test/rss",
    };
    mocks.countryFeeds.X = {
      [S(3)]: "http://challenge.ma/feed/",
      [S(4)]: "https://www.a.test/rss/?a=1&b=2",
      [S(5)]: "https://B.TEST/rss/",
      [S(6)]: "https://c1.test/rss",
      [S(7)]: "https://c2.test/rss",
      [S(8)]: "https://c3.test/rss",
      [S(9)]: "https://c4.test/rss",
      [S(10)]: "https://c5.test/rss",
      [S(11)]: "https://c6.test/rss",
      [S(12)]: "https://c7.test/rss",
    };
    const plan = planUnitFeeds(units);
    expect(plan.filter((f) => f.subtopic === "X").map((f) => f.url)).toEqual([
      "https://c1.test/rss",
      "https://c2.test/rss",
      "https://c3.test/rss",
      "https://c4.test/rss",
      "https://c5.test/rss",
      "https://c6.test/rss",
    ]);
  });

  it("a feed whose URL does not parse keys on its trimmed text: exact repeats skipped, different text kept, nothing throws", async () => {
    mocks.feeds[TOPIC] = { [S(0)]: "not a url", [S(1)]: "  " };
    mocks.countryFeeds.X = { [S(2)]: "not a url", [S(3)]: "Not A Url", [S(4)]: "  " };
    const plan = planUnitFeeds(units);
    expect(plan.map((f) => f.source)).toEqual([S(0), S(1), S(3)]);
    await expect(ingestUnits(units, [], null)).resolves.toEqual(expect.any(Array));
  });
});
