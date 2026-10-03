import { describe, it, expect, beforeEach, vi } from "vitest";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";

// Ingest by reading unit: a topic reads FEEDS, a country within Countries
// reads COUNTRY_FEEDS, each with its own 6 slots. A synthetic grid built from
// the real TOPICS and SOURCES by index, and twelve synthetic countries, so
// these tests don't depend on what the live catalog lists.
const mocks = vi.hoisted(() => ({
  parseURL: vi.fn(),
  feeds: {} as Record<string, Record<string, string>>,
  countryFeeds: {} as Record<string, Record<string, string>>,
  countries: [] as string[],
}));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));
vi.mock("@/config/feeds", () => ({ FEEDS: mocks.feeds }));
vi.mock("@/config/countries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/countries")>()),
  COUNTRIES: mocks.countries,
  COUNTRY_FEEDS: mocks.countryFeeds,
}));

import {
  ingestArticles,
  ingestUnits,
  planFeeds,
  planUnitFeeds,
  MAX_FEEDS_PER_TOPIC,
  MAX_TOPICS_PER_DIGEST,
} from "@/lib/ingest";
import { MAX_READING_UNITS, readingUnits, type ReadingUnit } from "@/lib/readingUnits";
import { COUNTRIES_TOPIC } from "@/config/countries";

const S = (i: number) => SOURCES[i] as Source;
const FEEDS_EACH = 9;
const COUNTRY_NAMES = Array.from({ length: 12 }, (_, i) => `Country ${i}`);
const topicUrl = (topic: string, source: Source) => `https://feeds.test/topic/${encodeURIComponent(topic)}/${encodeURIComponent(source)}`;
const countryUrl = (country: string, source: Source) => `https://feeds.test/country/${encodeURIComponent(country)}/${encodeURIComponent(source)}`;

const country = (name: string): ReadingUnit => ({ topic: COUNTRIES_TOPIC, subtopic: name });
const topic = (name: Topic): ReadingUnit => ({ topic: name, subtopic: null });
const AFRICA = "Africa" as Topic;

function fill() {
  for (const grid of [mocks.feeds, mocks.countryFeeds]) for (const key of Object.keys(grid)) delete grid[key];
  for (const t of TOPICS) {
    mocks.feeds[t] = {};
    // The real catalog files no feeds under the Countries container.
    if (t === COUNTRIES_TOPIC) continue;
    for (let s = 0; s < FEEDS_EACH; s++) mocks.feeds[t][S(s)] = topicUrl(t, S(s));
  }
  for (const name of COUNTRY_NAMES) {
    mocks.countryFeeds[name] = {};
    for (let s = 0; s < FEEDS_EACH; s++) mocks.countryFeeds[name][S(s)] = countryUrl(name, S(s));
  }
  mocks.countries.splice(0, mocks.countries.length, ...COUNTRY_NAMES);
}

/** Every planned feed answers with one item, titled with its own URL. */
function oneItemPerFeed(link: (url: string) => string = (url) => `${url}/item`) {
  mocks.parseURL.mockImplementation(async (url: string) => ({
    items: [{ title: url, link: link(url), contentSnippet: "text", isoDate: new Date().toISOString() }],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fill();
  mocks.parseURL.mockResolvedValue({ items: [] });
});

describe("planUnitFeeds: slots per unit", () => {
  it("gives a country its own first 6 feeds from COUNTRY_FEEDS", () => {
    const plan = planUnitFeeds([country("Country 0")]);
    expect(plan.map((f) => f.url)).toEqual([0, 1, 2, 3, 4, 5].map((i) => countryUrl("Country 0", S(i))));
    expect(plan.every((f) => f.topic === COUNTRIES_TOPIC && f.subtopic === "Country 0")).toBe(true);
  });

  it("puts the reader's preferred outlets first within a country, in the country's own order", () => {
    const plan = planUnitFeeds([country("Country 0")], [S(8), S(7)]);
    expect(plan.map((f) => f.source)).toEqual([7, 8, 0, 1, 2, 3].map(S));
  });

  it("gives a country and a topic in one digest 6 slots each", () => {
    const plan = planUnitFeeds([country("Country 0"), topic(AFRICA)]);
    expect(plan).toHaveLength(2 * MAX_FEEDS_PER_TOPIC);
    expect(plan.slice(MAX_FEEDS_PER_TOPIC).every((f) => f.topic === AFRICA && !("subtopic" in f))).toBe(true);
  });

  it("reads nothing for a country with no feeds, a name on Object's prototype, or Countries with no country", () => {
    expect(planUnitFeeds([country("Atlantis")])).toEqual([]);
    expect(planUnitFeeds([country("constructor"), country("__proto__"), country("toString")])).toEqual([]);
    expect(planUnitFeeds([{ topic: COUNTRIES_TOPIC, subtopic: null }])).toEqual([]);
  });

  it("reads a topic unit from FEEDS even if it carries a stray subtopic", () => {
    const plan = planUnitFeeds([{ topic: AFRICA, subtopic: "Country 0" }]);
    expect(plan.map((f) => f.url)).toEqual([0, 1, 2, 3, 4, 5].map((i) => topicUrl(AFRICA, S(i))));
    expect(plan.some((f) => "subtopic" in f)).toBe(false);
  });

  it("gives a feed a country shares with a later topic to the country, and the topic its next feed", () => {
    // The country files two of Africa's own feeds.
    mocks.countryFeeds["Country 0"] = {
      [S(0)]: topicUrl(AFRICA, S(0)),
      [S(1)]: topicUrl(AFRICA, S(1)),
      [S(2)]: countryUrl("Country 0", S(2)),
    };
    const plan = planUnitFeeds([country("Country 0"), topic(AFRICA)]);
    const urls = plan.map((f) => f.url);

    expect(new Set(urls).size).toBe(urls.length);
    expect(plan.filter((f) => f.subtopic === "Country 0").map((f) => f.source)).toEqual([0, 1, 2].map(S));
    expect(plan.filter((f) => f.topic === AFRICA).map((f) => f.source)).toEqual([2, 3, 4, 5, 6, 7].map(S));
  });

  it("keeps the units' order", () => {
    const plan = planUnitFeeds([topic(AFRICA), country("Country 3")]);
    expect(plan[0].topic).toBe(AFRICA);
    expect(plan[MAX_FEEDS_PER_TOPIC].subtopic).toBe("Country 3");
  });
});

describe("the spend bound", () => {
  it("is 10 units of 6 feeds", () => {
    expect(MAX_FEEDS_PER_TOPIC).toBe(6);
    expect(MAX_READING_UNITS).toBe(10);
    expect(MAX_TOPICS_PER_DIGEST).toBe(MAX_READING_UNITS);
  });

  it("10 units can never plan more than 60 feeds, whatever is preferred", () => {
    const ten = COUNTRY_NAMES.slice(0, 10).map(country);
    expect(planUnitFeeds(ten, [])).toHaveLength(60);
    expect(planUnitFeeds(ten, SOURCES.slice(0, FEEDS_EACH) as Source[])).toHaveLength(60);
    const mixed = [...COUNTRY_NAMES.slice(0, 5).map(country), ...(TOPICS.slice(0, 5) as Topic[]).map(topic)];
    expect(planUnitFeeds(mixed, SOURCES.slice() as Source[])).toHaveLength(60);
  });

  it("stays at 60 for a caller that passes more than 10 units", () => {
    const twelve = COUNTRY_NAMES.map(country);
    const plan = planUnitFeeds(twelve);
    expect(plan).toHaveLength(60);
    expect(new Set(plan.map((f) => f.subtopic))).toEqual(new Set(COUNTRY_NAMES.slice(0, 10)));
  });

  it("reads a repeated unit once, without letting the repeat take a slot", () => {
    const units = [country("Country 0"), country("Country 0"), ...COUNTRY_NAMES.slice(1, 10).map(country)];
    const plan = planUnitFeeds(units);
    expect(plan).toHaveLength(60);
    expect(new Set(plan.map((f) => f.url)).size).toBe(60);
  });

  it("the most a profile can pick, through readingUnits, fetches at most 60 feeds", async () => {
    const { read } = readingUnits([...TOPICS], COUNTRY_NAMES);
    await ingestUnits(read, SOURCES.slice() as Source[], null);
    expect(mocks.parseURL).toHaveBeenCalledTimes(60);
  });
});

describe("ingestUnits", () => {
  it("tags every article a country reads with Countries and the country, and no other article with a subtopic", async () => {
    oneItemPerFeed();
    const articles = await ingestUnits([country("Country 2"), topic(AFRICA)], [], null);

    const fromCountry = articles.filter((a) => a.title.includes("/country/"));
    const fromTopic = articles.filter((a) => a.title.includes("/topic/"));
    expect(fromCountry).toHaveLength(MAX_FEEDS_PER_TOPIC);
    expect(fromTopic).toHaveLength(MAX_FEEDS_PER_TOPIC);
    for (const a of fromCountry) {
      expect(a.topic).toBe(COUNTRIES_TOPIC);
      expect(a.subtopic).toBe("Country 2");
    }
    for (const a of fromTopic) {
      expect(a.topic).toBe(AFRICA);
      expect(a).not.toHaveProperty("subtopic");
    }
  });

  it("keeps an article a country shares with Africa once, under the country", async () => {
    // Every feed's item links to the same story.
    oneItemPerFeed(() => "https://news.test/one-story");
    // The real reading order: Countries sits before Africa in TOPICS.
    const { read } = readingUnits([AFRICA, COUNTRIES_TOPIC], ["Country 0"]);
    expect(read.map((u) => u.subtopic ?? u.topic)).toEqual(["Country 0", AFRICA]);

    const articles = await ingestUnits(read, [], null);

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({ topic: COUNTRIES_TOPIC, subtopic: "Country 0" });
  });

  it("keeps an article two countries share under the first one read", async () => {
    oneItemPerFeed(() => "https://news.test/one-story?utm_source=x");
    const articles = await ingestUnits([country("Country 5"), country("Country 1")], [], null);
    expect(articles).toHaveLength(1);
    expect(articles[0].subtopic).toBe("Country 5");
  });

  it("names the country when one of its feeds fails, and keeps the rest", async () => {
    const failing = countryUrl("Country 0", S(0));
    mocks.parseURL.mockImplementation(async (url: string) => {
      if (url === failing) throw new Error("feed down");
      return { items: [{ title: url, link: `${url}/item`, isoDate: new Date().toISOString() }] };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const articles = await ingestUnits([country("Country 0")], [], null);

    expect(articles).toHaveLength(MAX_FEEDS_PER_TOPIC - 1);
    expect(error.mock.calls.some((call) => String(call[0]).includes(`${S(0)}/${COUNTRIES_TOPIC}/Country 0`))).toBe(true);
    error.mockRestore();
  });
});

describe("the topic-only path shares the unit path", () => {
  it("planFeeds reads exactly what planUnitFeeds reads for the same topics with no countries", () => {
    const topics = [AFRICA, COUNTRIES_TOPIC, TOPICS[0]] as Topic[];
    expect(planFeeds(topics, [S(4)])).toEqual(planUnitFeeds(readingUnits(topics, []).read, [S(4)]));
  });

  it("the Countries container takes no slot among the 10 topics", () => {
    const eleven = [...(TOPICS.filter((t) => t !== COUNTRIES_TOPIC).slice(0, 10) as Topic[]), COUNTRIES_TOPIC];
    const plan = planFeeds(eleven);
    expect(plan).toHaveLength(60);
    expect(plan.some((f) => f.topic === COUNTRIES_TOPIC)).toBe(false);
  });

  it("ingestArticles fetches the same feeds as ingestUnits and tags nothing with a subtopic", async () => {
    oneItemPerFeed();
    const topics = [AFRICA, COUNTRIES_TOPIC] as Topic[];

    const articles = await ingestArticles(topics, [], null);
    const viaArticles = mocks.parseURL.mock.calls.map(([url]) => url);
    mocks.parseURL.mockClear();
    await ingestUnits(readingUnits(topics, []).read, [], null);
    const viaUnits = mocks.parseURL.mock.calls.map(([url]) => url);

    expect(viaArticles).toEqual(viaUnits);
    expect(articles).toHaveLength(MAX_FEEDS_PER_TOPIC);
    expect(articles.some((a) => "subtopic" in a)).toBe(false);
  });
});
