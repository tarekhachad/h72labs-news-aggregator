import { describe, it, expect, beforeEach, vi } from "vitest";
import { SOURCES, TOPICS, type Article, type Source, type Topic } from "@/types";

const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import { dedupeArticles, ingestArticles, normalizeArticleUrl, normalizeTitle, planFeeds } from "@/lib/ingest";
import { FEEDS } from "@/config/feeds";

const S = (i: number) => SOURCES[i] as Source;
const TOPIC = TOPICS[0] as Topic;

function article(url: string, title: string, source: Source = S(0)): Article {
  return { url, title, source, topic: TOPIC, snippet: "", publishedAt: "2026-10-02T10:00:00Z" };
}

const key = normalizeArticleUrl;

describe("normalizeArticleUrl: the same article under two addresses", () => {
  const base = "https://news.example.com/world/story-123";

  it.each([
    ["upper-case scheme and host", "HTTPS://NEWS.Example.COM/world/story-123"],
    ["a fragment", `${base}#comments`],
    ["utm_* tracking tags", `${base}?utm_source=rss&utm_medium=feed&UTM_Campaign=x`],
    ["fbclid", `${base}?fbclid=abc123`],
    ["gclid", `${base}?gclid=abc123`],
    ["ocid", `${base}?ocid=msnrss`],
    ["a trailing slash", `${base}/`],
    ["several trailing slashes", `${base}//`],
    ["an /amp suffix", `${base}/amp`],
    ["an /amp/ suffix", `${base}/amp/`],
    ["an /amp/ prefix", "https://news.example.com/amp/world/story-123"],
    ["an amp query flag", `${base}?amp`],
    ["amp=1", `${base}?amp=1`],
    ["outputType=amp", `${base}?outputType=amp`],
    ["an amp. host", "https://amp.news.example.com/world/story-123"],
    ["a www. host", "https://www.news.example.com/world/story-123"],
    ["an m. host", "https://m.news.example.com/world/story-123"],
    ["http instead of https", "http://news.example.com/world/story-123"],
    ["an explicit default port", "https://news.example.com:443/world/story-123"],
    ["all of the above at once", "HTTP://WWW.news.example.com/amp/world/story-123/?utm_source=x&fbclid=y#top"],
  ])("ignores %s", (_label, variant) => {
    expect(key(variant)).toBe(key(base));
  });

  it("keeps parameters that identify the article, in any order", () => {
    expect(key("https://example.com/a?id=1&page=2")).toBe(key("https://example.com/a?page=2&utm_source=x&id=1"));
    expect(key("https://example.com/a?id=1")).not.toBe(key("https://example.com/a?id=2"));
    expect(key("https://example.com/a?id=1")).not.toBe(key("https://example.com/a"));
  });

  it("keeps outputType when it selects something other than AMP", () => {
    expect(key("https://example.com/a?outputType=xml")).not.toBe(key("https://example.com/a"));
  });

  it("keeps path case, which servers may treat as significant", () => {
    expect(key("https://example.com/Story")).not.toBe(key("https://example.com/story"));
  });

  it("does not merge different articles or different sites", () => {
    expect(key("https://example.com/story-1")).not.toBe(key("https://example.com/story-2"));
    expect(key("https://example.com/story")).not.toBe(key("https://example.org/story"));
    expect(key("https://example.com/story")).not.toBe(key("https://example.com:8080/story"));
  });

  it("does not treat 'amp' inside a word as the AMP variant", () => {
    expect(key("https://example.com/news/champions")).not.toBe(key("https://example.com/news/ch"));
    expect(key("https://example.com/camp")).toBe("example.com/camp");
  });

  it("falls back to exact matching for something that isn't an http(s) URL", () => {
    expect(key("  not a url  ")).toBe("not a url");
    expect(key("ftp://example.com/a")).toBe("ftp://example.com/a");
  });

  it("gives an empty link no key at all", () => {
    expect(key("")).toBeNull();
    expect(key("   ")).toBeNull();
  });
});

describe("normalizeTitle", () => {
  it("ignores case, punctuation, quotes and spacing", () => {
    expect(normalizeTitle("  Fed Raises Rates — Again!  ")).toBe(normalizeTitle("fed raises rates again"));
    expect(normalizeTitle("“Quoted” headline")).toBe(normalizeTitle('"quoted" HEADLINE'));
  });

  it("keeps non-Latin letters and digits", () => {
    expect(normalizeTitle("Élection 2026 : résultats")).toBe("élection 2026 résultats");
  });

  it("keeps combining vowel signs, so two different words in an abugida stay different", () => {
    expect(normalizeTitle("काल")).not.toBe(normalizeTitle("किल"));
  });

  it("gives an empty or punctuation-only headline no key", () => {
    expect(normalizeTitle("")).toBeNull();
    expect(normalizeTitle(" — ! ")).toBeNull();
  });
});

describe("dedupeArticles", () => {
  it("keeps the first sighting, with the URL its feed gave", () => {
    const first = article("https://example.com/a?utm_source=rss", "One");
    const second = article("https://www.example.com/a/", "One (updated)", S(1));
    expect(dedupeArticles([first, second])).toEqual([first]);
  });

  it("treats one outlet's two links under the same headline as one article", () => {
    const first = article("https://example.com/a", "Same Headline");
    const second = article("https://example.com/reissued-a", "same headline!");
    expect(dedupeArticles([first, second])).toEqual([first]);
  });

  it("keeps two outlets running the same headline: they are two sources", () => {
    const a = article("https://one.example/a", "Wire Headline", S(0));
    const b = article("https://two.example/b", "Wire Headline", S(1));
    expect(dedupeArticles([a, b])).toEqual([a, b]);
  });

  it("keeps one outlet's different headlines at different links", () => {
    const a = article("https://example.com/a", "First story");
    const b = article("https://example.com/b", "Second story");
    expect(dedupeArticles([a, b])).toEqual([a, b]);
  });

  it("never merges untitled items, or items without a link, on that absence alone", () => {
    const untitled = [article("https://example.com/a", ""), article("https://example.com/b", "")];
    expect(dedupeArticles(untitled)).toEqual(untitled);
    const unlinked = [article("", "First"), article("", "Second")];
    expect(dedupeArticles(unlinked)).toEqual(unlinked);
  });

  it("can't be fooled into a title match by an outlet name containing the separator", () => {
    // Without structured keys, ("A", "B C") and ("A B", "C") could collide.
    const a = { ...article("https://x.example/1", "b c"), source: "a" as Source };
    const b = { ...article("https://x.example/2", "c"), source: "a b" as Source };
    expect(dedupeArticles([a, b])).toEqual([a, b]);
  });

  it("leaves the input untouched", () => {
    const input = [article("https://example.com/a", "One"), article("https://example.com/a/", "One")];
    const copy = structuredClone(input);
    dedupeArticles(input);
    expect(input).toEqual(copy);
  });
});

describe("ingestArticles removes duplicates across feeds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps one copy of an article that two feeds carry under different addresses", async () => {
    // Two feeds of the real catalog's first topic; whichever is fetched first wins.
    const [first] = planFeeds([TOPIC], []);
    mocks.parseURL.mockImplementation(async (url: string) => ({
      items: [
        {
          title: "Shared story",
          link:
            url === first.url
              ? "https://example.com/shared?utm_source=feed-one"
              : "https://www.example.com/shared/#ref",
          isoDate: new Date().toISOString(),
        },
      ],
    }));

    const articles = await ingestArticles([TOPIC], [], null);

    expect(articles).toHaveLength(1);
    expect(articles[0].url).toBe("https://example.com/shared?utm_source=feed-one");
    expect(articles[0].source).toBe(first.source);
  });
});

describe("the real catalog", () => {
  it("with zero preferred sources reads min(6, feeds) for every topic", () => {
    for (const topic of TOPICS) {
      const available = Object.keys(FEEDS[topic as Topic] ?? {}).length;
      expect(planFeeds([topic as Topic], []), topic).toHaveLength(Math.min(6, available));
    }
  });
});
