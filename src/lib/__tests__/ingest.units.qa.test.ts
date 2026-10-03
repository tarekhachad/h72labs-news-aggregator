import { describe, it, expect, beforeEach, vi } from "vitest";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";

// QA probes for ingest by reading unit, against a synthetic catalog so the
// expectations don't move when the live catalog does.
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

import { ingestArticles, ingestUnits, planFeeds, planUnitFeeds, MAX_FEEDS_PER_TOPIC } from "@/lib/ingest";
import { readingUnits, type ReadingUnit } from "@/lib/readingUnits";
import { COUNTRIES_TOPIC } from "@/config/countries";

const S = (i: number) => SOURCES[i] as Source;
const FEEDS_EACH = 9;
const COUNTRY_NAMES = Array.from({ length: 12 }, (_, i) => `Country ${i}`);
const topicUrl = (t: string, s: Source) => `https://feeds.test/topic/${encodeURIComponent(t)}/${encodeURIComponent(s)}`;
const countryUrl = (c: string, s: Source) => `https://feeds.test/country/${encodeURIComponent(c)}/${encodeURIComponent(s)}`;
const country = (name: string): ReadingUnit => ({ topic: COUNTRIES_TOPIC, subtopic: name });
const topic = (name: string): ReadingUnit => ({ topic: name as Topic, subtopic: null });
const AFRICA = "Africa" as Topic;
const REAL_TOPICS = TOPICS.filter((t) => t !== COUNTRIES_TOPIC) as Topic[];

function fill() {
  for (const grid of [mocks.feeds, mocks.countryFeeds]) for (const key of Object.keys(grid)) delete grid[key];
  for (const t of TOPICS) {
    mocks.feeds[t] = {};
    if (t === COUNTRIES_TOPIC) continue;
    for (let s = 0; s < FEEDS_EACH; s++) mocks.feeds[t][S(s)] = topicUrl(t, S(s));
  }
  for (const name of COUNTRY_NAMES) {
    mocks.countryFeeds[name] = {};
    for (let s = 0; s < FEEDS_EACH; s++) mocks.countryFeeds[name][S(s)] = countryUrl(name, S(s));
  }
  mocks.countries.splice(0, mocks.countries.length, ...COUNTRY_NAMES);
}

function items(make: (url: string) => Record<string, unknown>[]) {
  mocks.parseURL.mockImplementation(async (url: string) => ({ items: make(url) }));
}
const fresh = () => new Date().toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  fill();
  mocks.parseURL.mockResolvedValue({ items: [] });
});

describe("spend bound under adversarial units", () => {
  it("a thousand mixed, repeated and junk units still plan at most 60 feeds", () => {
    const junk: ReadingUnit[] = [];
    for (let i = 0; i < 1000; i++) {
      const pick = i % 5;
      if (pick === 0) junk.push(country(COUNTRY_NAMES[i % COUNTRY_NAMES.length]));
      else if (pick === 1) junk.push(topic(REAL_TOPICS[i % REAL_TOPICS.length]));
      else if (pick === 2) junk.push({ topic: REAL_TOPICS[i % REAL_TOPICS.length], subtopic: `stray ${i}` });
      else if (pick === 3) junk.push(country(`Nowhere ${i}`));
      else junk.push({ topic: COUNTRIES_TOPIC, subtopic: null });
    }
    expect(planUnitFeeds(junk, SOURCES.slice() as Source[]).length).toBeLessThanOrEqual(60);
  });

  it("ingestUnits fetches at most 60 feeds for 1000 distinct country units", async () => {
    for (let i = 0; i < 1000; i++) {
      const name = `Extra ${i}`;
      mocks.countryFeeds[name] = {};
      for (let s = 0; s < FEEDS_EACH; s++) mocks.countryFeeds[name][S(s)] = countryUrl(name, S(s));
    }
    const units = Object.keys(mocks.countryFeeds).map(country);
    await ingestUnits(units, [], null);
    expect(mocks.parseURL.mock.calls.length).toBeLessThanOrEqual(60);
  });

  it("a unit with an undefined subtopic is the same unit as one with null", () => {
    const plan = planUnitFeeds([
      { topic: AFRICA, subtopic: null },
      { topic: AFRICA } as unknown as ReadingUnit,
    ]);
    expect(plan).toHaveLength(MAX_FEEDS_PER_TOPIC);
  });

  it("never fetches the same feed URL twice in one plan", () => {
    // A topic unit carrying stray subtopics reads FEEDS[topic] each time; a
    // repeated read is wasted spend and only counts against the 60.
    const plan = planUnitFeeds([
      topic(AFRICA),
      { topic: AFRICA, subtopic: "a" },
      { topic: AFRICA, subtopic: "b" },
      { topic: COUNTRIES_TOPIC, subtopic: "" },
      { topic: COUNTRIES_TOPIC, subtopic: null },
    ]);
    const urls = plan.map((f) => f.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("prototype-key and odd names", () => {
  it("reads nothing for prototype-key country names", () => {
    const names = ["__proto__", "constructor", "hasOwnProperty", "valueOf", "toString", "isPrototypeOf", "__defineGetter__"];
    expect(planUnitFeeds(names.map(country))).toEqual([]);
  });

  it("reads nothing for prototype-key topic names", () => {
    expect(planUnitFeeds(["__proto__", "constructor", "toString", "hasOwnProperty"].map(topic))).toEqual([]);
  });

  it("does not resolve a country by a case or whitespace variant", () => {
    expect(planUnitFeeds([country("country 0"), country(" Country 0"), country("Country 0 ")])).toEqual([]);
  });

  it("a country named like a topic reads the country's feeds, not the topic's", () => {
    mocks.countryFeeds["Africa"] = { [S(0)]: countryUrl("Africa", S(0)) };
    const plan = planUnitFeeds([country("Africa")]);
    expect(plan).toEqual([{ topic: COUNTRIES_TOPIC, subtopic: "Africa", source: S(0), url: countryUrl("Africa", S(0)) }]);
  });

  it("the Countries container as a plain topic reads nothing even when FEEDS lists feeds under it", () => {
    // planFeeds goes through readingUnits, so even a polluted FEEDS.Countries can't take slots.
    mocks.feeds[COUNTRIES_TOPIC] = { [S(0)]: "https://feeds.test/polluted" };
    expect(planFeeds([COUNTRIES_TOPIC as Topic])).toEqual([]);
  });
});

describe("the Countries container in the topic-only path", () => {
  it("takes no slot even when it sorts among the first 10 topics", () => {
    // Nine real topics that sort before Countries, Countries, and Africa after it:
    // 10 units, so Africa must still be read.
    const before = TOPICS.slice(0, TOPICS.indexOf(COUNTRIES_TOPIC)).slice(0, 9) as Topic[];
    expect(before).toHaveLength(9);
    const plan = planFeeds([...before, COUNTRIES_TOPIC as Topic, AFRICA]);
    expect(plan).toHaveLength(60);
    expect(plan.some((f) => f.topic === AFRICA)).toBe(true);
  });
});

describe("preferred outlets spanning a topic and a country", () => {
  it("one preferred outlet leads both the country's and the topic's slots", () => {
    const plan = planUnitFeeds([country("Country 0"), topic(AFRICA)], [S(8)]);
    expect(plan[0]).toMatchObject({ subtopic: "Country 0", source: S(8) });
    expect(plan[MAX_FEEDS_PER_TOPIC]).toMatchObject({ topic: AFRICA, source: S(8) });
    expect(plan[MAX_FEEDS_PER_TOPIC]).not.toHaveProperty("subtopic");
  });

  it("a preferred outlet only the country has leads the country and doesn't touch the topic", () => {
    const only = S(40);
    mocks.countryFeeds["Country 0"][only] = countryUrl("Country 0", only);
    const plan = planUnitFeeds([country("Country 0"), topic(AFRICA)], [only]);
    expect(plan[0].source).toBe(only);
    expect(plan.slice(MAX_FEEDS_PER_TOPIC).map((f) => f.source)).toEqual([0, 1, 2, 3, 4, 5].map(S));
  });

  it("preferred outlets never add slots beyond 6 per unit", () => {
    const plan = planUnitFeeds([country("Country 0")], SOURCES.slice() as Source[]);
    expect(plan).toHaveLength(MAX_FEEDS_PER_TOPIC);
  });
});

describe("dedupe precedence", () => {
  it("a same-outlet headline shared with Africa stays with the country (title match, different links)", async () => {
    items((url) => [{ title: "One shared headline", link: `${url}/item`, contentSnippet: "x", isoDate: fresh() }]);
    const { read } = readingUnits([AFRICA, COUNTRIES_TOPIC], ["Country 0"]);
    const articles = await ingestUnits(read, [], null);
    expect(articles).toHaveLength(MAX_FEEDS_PER_TOPIC);
    expect(articles.every((a) => a.topic === COUNTRIES_TOPIC && a.subtopic === "Country 0")).toBe(true);
  });

  it("between two countries, the one earlier in COUNTRIES wins regardless of pick order", async () => {
    items(() => [{ title: "t", link: "https://news.test/shared", contentSnippet: "x", isoDate: fresh() }]);
    const { read } = readingUnits([COUNTRIES_TOPIC], ["Country 7", "Country 2"]);
    const articles = await ingestUnits(read, [], null);
    expect(articles).toHaveLength(1);
    expect(articles[0].subtopic).toBe("Country 2");
  });

  it("an earlier topic (before Countries in TOPICS) keeps a shared article untagged", async () => {
    items(() => [{ title: "t", link: "https://news.test/shared", contentSnippet: "x", isoDate: fresh() }]);
    const earlier = TOPICS[0] as Topic;
    const { read } = readingUnits([COUNTRIES_TOPIC, earlier], ["Country 0"]);
    const articles = await ingestUnits(read, [], null);
    expect(articles).toHaveLength(1);
    expect(articles[0].topic).toBe(earlier);
    expect(articles[0]).not.toHaveProperty("subtopic");
  });

  it("the order is the fetch order, not the completion order", async () => {
    // The country's feed answers last; it was planned first, so it still wins.
    mocks.parseURL.mockImplementation(async (url: string) => {
      if (url.includes("/country/")) await new Promise((r) => setTimeout(r, 20));
      return { items: [{ title: "t", link: "https://news.test/shared", contentSnippet: "x", isoDate: fresh() }] };
    });
    const articles = await ingestUnits([country("Country 0"), topic(AFRICA)], [], null);
    expect(articles).toHaveLength(1);
    expect(articles[0].subtopic).toBe("Country 0");
  });
});

describe("subtopic presence", () => {
  it("a country article carries subtopic as a string, a topic article has no subtopic key at all (not null, not undefined)", async () => {
    items((url) => [{ title: url, link: `${url}/i`, contentSnippet: "x", isoDate: fresh() }]);
    const articles = await ingestUnits([country("Country 3"), topic(AFRICA)], [], null);
    for (const a of articles) {
      if (a.topic === COUNTRIES_TOPIC) expect(a.subtopic).toBe("Country 3");
      else expect(Object.keys(a)).not.toContain("subtopic");
    }
  });

  it("ingestArticles never tags a subtopic and never reads a country feed", async () => {
    items((url) => [{ title: url, link: `${url}/i`, contentSnippet: "x", isoDate: fresh() }]);
    const articles = await ingestArticles([AFRICA, COUNTRIES_TOPIC as Topic, TOPICS[0] as Topic], [], null);
    expect(articles.length).toBe(2 * MAX_FEEDS_PER_TOPIC);
    expect(articles.some((a) => Object.keys(a).includes("subtopic"))).toBe(false);
    expect(mocks.parseURL.mock.calls.some(([u]) => String(u).includes("/country/"))).toBe(false);
  });
});

describe("cutoff applies to country articles on the real clock", () => {
  it("drops a country item older than 48h and one older than the cursor", async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    items((url) => [
      { title: `${url} 1h`, link: `${url}/1`, contentSnippet: "x", isoDate: hoursAgo(1) },
      { title: `${url} 10h`, link: `${url}/10`, contentSnippet: "x", isoDate: hoursAgo(10) },
      { title: `${url} 49h`, link: `${url}/49`, contentSnippet: "x", isoDate: hoursAgo(49) },
    ]);
    const all = await ingestUnits([country("Country 0")], [], null);
    expect(all.every((a) => !a.title.endsWith("49h"))).toBe(true);
    expect(all).toHaveLength(2 * MAX_FEEDS_PER_TOPIC);
    const since = await ingestUnits([country("Country 0")], [], hoursAgo(5));
    expect(since.every((a) => a.title.endsWith("1h"))).toBe(true);
  });
});
