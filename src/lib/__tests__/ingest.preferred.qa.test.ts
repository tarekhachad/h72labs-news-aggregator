import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, TOPICS, type Article, type Source, type Topic } from "@/types";

// QA round 1 for the optional-preferred-sources ingest changes: URL keys that
// must NOT merge two different articles, obvious duplicates that must merge,
// the slot plan against the real catalog, the topic bound, and the order of
// duplicate removal relative to the since-cutoff. Never names a topic or an
// outlet: everything is read off TOPICS / SOURCES / FEEDS.

const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import {
  dedupeArticles,
  ingestArticles,
  normalizeArticleUrl,
  planFeeds,
  topicsToRead,
  MAX_FEEDS_PER_TOPIC,
  MAX_TOPICS_PER_DIGEST,
} from "@/lib/ingest";
import { FEEDS } from "@/config/feeds";

const key = normalizeArticleUrl;
const TOPIC = TOPICS[0] as Topic;
const S = (i: number) => SOURCES[i] as Source;

function article(url: string, title: string, source: Source = S(0), publishedAt = "2026-10-02T10:00:00Z"): Article {
  return { url, title, source, topic: TOPIC, snippet: "", publishedAt };
}

const feedsOf = (topic: Topic) => Object.entries(FEEDS[topic] ?? {}) as [Source, string][];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseURL.mockResolvedValue({ items: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeArticleUrl never merges two different articles", () => {
  it.each([
    ["different query ids", "https://ex.test/article?id=1", "https://ex.test/article?id=2"],
    ["a page param", "https://ex.test/a?page=1", "https://ex.test/a?page=2"],
    ["a non-tracking param vs none", "https://ex.test/a?p=123", "https://ex.test/a"],
    ["different paths under one host", "https://ex.test/2026/10/02/a", "https://ex.test/2026/10/02/b"],
    ["a path ending in a word containing amp", "https://ex.test/news/stamp", "https://ex.test/news/st"],
    ["an amp segment in the middle of the path", "https://ex.test/a/amp/b", "https://ex.test/a/b"],
    ["different subdomains that are not www/amp/m", "https://news.ex.test/a", "https://sport.ex.test/a"],
    ["a host starting with m but not m.", "https://media.ex.test/a", "https://dia.ex.test/a"],
    ["a different port", "https://ex.test/a", "https://ex.test:8443/a"],
    ["a plus sign that is data, not a space", "https://ex.test/a?q=a%2Bb", "https://ex.test/a?q=a+b"],
    ["param name case", "https://ex.test/a?ID=1", "https://ex.test/a?id=1"],
    ["a param whose name merely contains utm", "https://ex.test/a?xutm_source=1", "https://ex.test/a"],
  ])("%s", (_label, a, b) => {
    expect(key(a)).not.toBe(key(b));
  });

  it("does not merge two different hash-routed articles on one page (fragment is dropped)", () => {
    // A single-page site that routes articles by fragment: the fragment IS the article.
    expect(key("https://ex.test/#/article/1")).not.toBe(key("https://ex.test/#/article/2"));
  });

  it("does not turn an /amp article path into the site's home page", () => {
    expect(key("https://ex.test/amp")).not.toBe(key("https://ex.test/"));
  });
});

describe("normalizeArticleUrl still catches obvious duplicates", () => {
  const base = "https://ex.test/world/story-9";
  it.each([
    ["mixed tracking params in any order", `${base}?utm_campaign=c&id=7&fbclid=f`, `${base}?id=7`],
    ["reordered real params", "https://ex.test/a?b=2&a=1", "https://ex.test/a?a=1&b=2"],
    ["percent-encoded vs raw unicode path", "https://ex.test/caf%C3%A9", "https://ex.test/café"],
    ["dot segments", "https://ex.test/a/./b", "https://ex.test/a/b"],
    ["surrounding whitespace", `  ${base}\n`, base],
    ["upper-case tracking param names", `${base}?UTM_SOURCE=x&FBCLID=y`, base],
  ])("%s", (_label, a, b) => {
    expect(key(a)).toBe(key(b));
  });
});

describe("dedupeArticles and the since-cutoff", () => {
  it("does not let a stale sighting shadow a fresh article from the same outlet with the same headline", async () => {
    // Two of one outlet's feeds (two topics) carry the same headline: an old
    // item, already behind the reader's cursor, in the first-read feed, and a
    // new item at a different link in the second. The new one is the article
    // this run exists to surface.
    const outlet = SOURCES.find((s) => TOPICS.filter((t) => FEEDS[t as Topic]?.[s]).length >= 2) as Source;
    const [t1, t2] = TOPICS.filter((t) => FEEDS[t as Topic]?.[outlet]) as Topic[];
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    mocks.parseURL.mockImplementation(async (url: string) => {
      if (url === FEEDS[t1]?.[outlet]) {
        return { items: [{ title: "Market wrap", link: "https://ex.test/wrap-yesterday", isoDate: stale }] };
      }
      if (url === FEEDS[t2]?.[outlet]) {
        return { items: [{ title: "Market wrap", link: "https://ex.test/wrap-today", isoDate: fresh }] };
      }
      return { items: [] };
    });

    const articles = await ingestArticles([t1, t2], [outlet], sinceIso);

    expect(articles.map((a) => a.url)).toEqual(["https://ex.test/wrap-today"]);
  });

  it("keeps the first sighting when both are fresh (unchanged contract)", () => {
    const a = article("https://ex.test/a", "Same", S(0));
    const b = article("https://ex.test/b", "Same", S(0));
    expect(dedupeArticles([a, b])).toEqual([a]);
  });
});

describe("planFeeds against the real catalog", () => {
  it("reads at most MAX_FEEDS_PER_TOPIC per topic and MAX_TOPICS_PER_DIGEST topics, whatever is preferred", () => {
    const all = [...TOPICS] as Topic[];
    for (const preferred of [[], [...SOURCES]] as Source[][]) {
      const plan = planFeeds(all, preferred);
      expect(plan.length).toBeLessThanOrEqual(MAX_FEEDS_PER_TOPIC * MAX_TOPICS_PER_DIGEST);
      const perTopic = new Map<Topic, number>();
      for (const f of plan) perTopic.set(f.topic, (perTopic.get(f.topic) ?? 0) + 1);
      expect(perTopic.size).toBeLessThanOrEqual(MAX_TOPICS_PER_DIGEST);
      for (const n of perTopic.values()) expect(n).toBeLessThanOrEqual(MAX_FEEDS_PER_TOPIC);
    }
  });

  it("never plans the same feed twice", () => {
    const plan = planFeeds([...TOPICS] as Topic[], [...SOURCES]);
    expect(new Set(plan.map((f) => `${f.topic}|${f.source}`)).size).toBe(plan.length);
  });

  it("for a topic with more feeds than slots, the last catalog feed gets a slot only when preferred", () => {
    const topic = TOPICS.find((t) => feedsOf(t as Topic).length > MAX_FEEDS_PER_TOPIC) as Topic;
    expect(topic).toBeDefined();
    const [lastSource, lastUrl] = feedsOf(topic).at(-1)!;
    expect(planFeeds([topic], []).some((f) => f.url === lastUrl)).toBe(false);
    const withPick = planFeeds([topic], [lastSource]);
    expect(withPick[0]).toEqual({ topic, source: lastSource, url: lastUrl });
    expect(withPick).toHaveLength(MAX_FEEDS_PER_TOPIC);
    // The pick displaces the last default slot, not one of the first five.
    expect(withPick.slice(1).map((f) => f.source)).toEqual(
      feedsOf(topic).slice(0, MAX_FEEDS_PER_TOPIC - 1).map(([s]) => s)
    );
  });

  it("a preferred outlet with no feed for any read topic leaves the plan exactly as with zero preferences", () => {
    const topics = TOPICS.slice(0, 3) as Topic[];
    const absent = SOURCES.find((s) => topics.every((t) => !FEEDS[t]?.[s]));
    if (!absent) return; // every outlet covers one of these topics; nothing to check
    expect(planFeeds(topics, [absent])).toEqual(planFeeds(topics, []));
  });

  it("fetches each planned URL exactly once and nothing else", async () => {
    const topics = [...TOPICS] as Topic[];
    await ingestArticles(topics, [...SOURCES], null);
    const fetched = mocks.parseURL.mock.calls.map(([u]) => u).sort();
    expect(fetched).toEqual(planFeeds(topics, [...SOURCES]).map((f) => f.url).sort());
  });
});

describe("topicsToRead", () => {
  it("is independent of input order and of duplicates", () => {
    const all = [...TOPICS] as Topic[];
    const a = topicsToRead(all);
    const b = topicsToRead([...all].reverse().concat(all));
    expect(b).toEqual(a);
  });

  it("read and dropped partition the distinct topics", () => {
    const all = [...TOPICS, TOPICS[0]] as Topic[];
    const { read, dropped } = topicsToRead(all);
    expect(new Set([...read, ...dropped])).toEqual(new Set(TOPICS));
    expect(read.length + dropped.length).toBe(TOPICS.length);
    expect(read.filter((t) => dropped.includes(t))).toEqual([]);
  });

  it("returns empty for an empty profile", () => {
    expect(topicsToRead([])).toEqual({ read: [], dropped: [] });
  });
});
