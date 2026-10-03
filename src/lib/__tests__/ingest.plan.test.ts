import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";

// A synthetic feed grid built from the real TOPICS/SOURCES by index, so these
// tests don't depend on which outlets the live catalog lists for which topic
// (that catalog is edited independently and keeps growing).
const mocks = vi.hoisted(() => ({
  parseURL: vi.fn(),
  feeds: {} as Record<string, Record<string, string>>,
}));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));
vi.mock("@/config/feeds", () => ({ FEEDS: mocks.feeds }));

import {
  ingestArticles,
  planFeeds,
  topicsToRead,
  MAX_FEEDS_PER_TOPIC,
  MAX_TOPICS_PER_DIGEST,
} from "@/lib/ingest";

const S = (i: number) => SOURCES[i] as Source;
const T = (i: number) => TOPICS[i] as Topic;
const urlFor = (topic: Topic, source: Source) => `https://feeds.test/${encodeURIComponent(topic)}/${encodeURIComponent(source)}`;

/**
 * The last topic has only three feeds; every other topic has nine (S0..S8).
 * Last, so the first ten topics are all full ones.
 */
const THIN_TOPIC = TOPICS.length - 1;
const FULL_FEEDS = 9;
const THIN_FEEDS = 3;

function fillFeeds() {
  for (const key of Object.keys(mocks.feeds)) delete mocks.feeds[key];
  TOPICS.forEach((topic, t) => {
    const count = t === THIN_TOPIC ? THIN_FEEDS : FULL_FEEDS;
    mocks.feeds[topic] = {};
    for (let s = 0; s < count; s++) mocks.feeds[topic][S(s)] = urlFor(topic, S(s));
  });
}

const sourcesOf = (topic: Topic, preferred: Source[]) =>
  planFeeds([topic], preferred).map((f) => f.source);

beforeEach(() => {
  vi.clearAllMocks();
  fillFeeds();
  mocks.parseURL.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the bounds", () => {
  it("are the decided 6 feeds per topic and 10 topics per digest", () => {
    expect(MAX_FEEDS_PER_TOPIC).toBe(6);
    expect(MAX_TOPICS_PER_DIGEST).toBe(10);
  });

  it("the synthetic catalog is big enough to exercise them", () => {
    expect(TOPICS.length).toBeGreaterThan(MAX_TOPICS_PER_DIGEST);
    expect(SOURCES.length).toBeGreaterThanOrEqual(FULL_FEEDS);
  });
});

describe("planFeeds: slots per topic", () => {
  it("with zero preferred sources, gives each topic its first 6 feeds in catalog order", () => {
    expect(sourcesOf(T(0), [])).toEqual([0, 1, 2, 3, 4, 5].map(S));
    expect(planFeeds([T(0), T(2)], [])).toHaveLength(2 * MAX_FEEDS_PER_TOPIC);
  });

  it("treats an omitted preference list the same as an empty one", () => {
    expect(planFeeds([T(0)])).toEqual(planFeeds([T(0)], []));
  });

  it("puts preferred outlets in the first slots, then fills from catalog order", () => {
    expect(sourcesOf(T(0), [S(7), S(8)])).toEqual([7, 8, 0, 1, 2, 3].map(S));
  });

  it("orders preferred outlets by the topic's catalog order, not the order they were picked", () => {
    expect(sourcesOf(T(0), [S(8), S(7)])).toEqual([7, 8, 0, 1, 2, 3].map(S));
  });

  it("with more than 6 preferred outlets on one topic, takes the first 6 of them in catalog order", () => {
    const preferred = [8, 7, 6, 5, 4, 3, 2, 1].map(S);
    expect(sourcesOf(T(0), preferred)).toEqual([1, 2, 3, 4, 5, 6].map(S));
  });

  it("ignores a preferred outlet that has no feed for a topic", () => {
    // S8 has no feed on the thin topic: it reads its 3 feeds and nothing else,
    // while a full topic in the same digest still gives S8 the first slot.
    const plan = planFeeds([T(0), T(THIN_TOPIC)], [S(8)]);
    expect(plan.filter((f) => f.topic === T(THIN_TOPIC)).map((f) => f.source)).toEqual([0, 1, 2].map(S));
    expect(plan.filter((f) => f.topic === T(0)).map((f) => f.source)[0]).toBe(S(8));
  });

  it("reads a topic with no feeds at all as zero feeds, not an error", () => {
    delete mocks.feeds[T(0)];
    expect(planFeeds([T(0)], [])).toEqual([]);
  });

  it("carries each feed's own URL", () => {
    for (const feed of planFeeds([T(0), T(3)], [S(5)])) {
      expect(feed.url).toBe(urlFor(feed.topic, feed.source));
    }
  });
});

describe("topicsToRead and the 10-topic bound", () => {
  const thirteen = TOPICS.slice(0, 13) as Topic[];

  it("reads the first 10 in curated order and reports the rest as dropped", () => {
    const { read, dropped } = topicsToRead([...thirteen].reverse());
    expect(read).toEqual(thirteen.slice(0, 10));
    expect(dropped).toEqual(thirteen.slice(10));
  });

  it("drops nothing at or under the bound", () => {
    expect(topicsToRead(thirteen.slice(0, 10)).dropped).toEqual([]);
    expect(topicsToRead(thirteen.slice(0, 3))).toEqual({ read: thirteen.slice(0, 3), dropped: [] });
  });

  it("counts a duplicated topic once", () => {
    expect(topicsToRead([T(0), T(0), T(1)]).read).toEqual([T(0), T(1)]);
  });

  it("sorts a name no longer in the catalog after every known topic", () => {
    const stale = "A Topic That Was Renamed" as Topic;
    const { read, dropped } = topicsToRead([stale, ...thirteen.slice(0, 10)]);
    expect(read).toEqual(thirteen.slice(0, 10));
    expect(dropped).toEqual([stale]);
  });

  it("caps a 13-topic profile with zero preferences at 60 feeds", () => {
    const plan = planFeeds(thirteen, []);
    expect(plan).toHaveLength(MAX_TOPICS_PER_DIGEST * MAX_FEEDS_PER_TOPIC);
    expect(new Set(plan.map((f) => f.topic))).toEqual(new Set(thirteen.slice(0, 10)));
  });

  it("caps it at 60 feeds whatever is preferred", () => {
    expect(planFeeds(thirteen, SOURCES.slice(0, FULL_FEEDS) as Source[])).toHaveLength(60);
  });
});

describe("ingestArticles fetches exactly the planned feeds", () => {
  it("with zero preferred sources, still reads every topic (not an empty digest)", async () => {
    mocks.parseURL.mockImplementation(async (url: string) => ({
      items: [{ title: `from ${url}`, link: `${url}/item`, isoDate: new Date().toISOString() }],
    }));

    const articles = await ingestArticles([T(0), T(2)], [], null);

    const fetched = mocks.parseURL.mock.calls.map(([url]) => url);
    expect(fetched).toEqual(planFeeds([T(0), T(2)], []).map((f) => f.url));
    expect(articles).toHaveLength(2 * MAX_FEEDS_PER_TOPIC);
  });

  it("never fetches more than 60 feeds for an oversized profile", async () => {
    await ingestArticles(TOPICS.slice(0, 13) as Topic[], [], null);
    expect(mocks.parseURL).toHaveBeenCalledTimes(60);
  });

  it("labels each article with the topic and source of the feed it came from", async () => {
    mocks.parseURL.mockImplementation(async (url: string) => ({
      items: [{ title: url, link: `${url}/item`, isoDate: new Date().toISOString() }],
    }));

    const articles = await ingestArticles([T(0)], [S(8)], null);

    for (const a of articles) expect(a.title).toBe(urlFor(a.topic, a.source));
    expect(articles[0].source).toBe(S(8));
  });

  it("skips a failing feed and keeps the rest", async () => {
    const failing = urlFor(T(0), S(0));
    mocks.parseURL.mockImplementation(async (url: string) => {
      if (url === failing) throw new Error("feed down");
      return { items: [{ title: url, link: `${url}/item`, isoDate: new Date().toISOString() }] };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const articles = await ingestArticles([T(0)], [], null);

    expect(articles).toHaveLength(MAX_FEEDS_PER_TOPIC - 1);
  });

  it("still returns the other feeds when the console itself throws while logging a failure", async () => {
    const failing = urlFor(T(0), S(0));
    mocks.parseURL.mockImplementation(async (url: string) => {
      if (url === failing) throw new Error("feed down");
      return { items: [{ title: url, link: `${url}/item`, isoDate: new Date().toISOString() }] };
    });
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console is dead");
    });

    await expect(ingestArticles([T(0)], [], null)).resolves.toHaveLength(MAX_FEEDS_PER_TOPIC - 1);
  });
});
