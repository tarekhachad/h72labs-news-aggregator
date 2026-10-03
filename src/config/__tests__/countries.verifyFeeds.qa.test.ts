import { describe, it, expect, beforeEach, vi } from "vitest";

// QA probes for scripts/verify-feeds.mts: non-string fields from the parser,
// and the catalog list it walks. Fake parser, fake network.

const state = vi.hoisted(() => ({
  parse: (async () => ({ items: [] })) as (url: string) => Promise<Record<string, unknown>>,
}));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL(url: string) {
      return state.parse(url);
    }
  },
}));

vi.stubGlobal("fetch", async (url: string): Promise<Response> =>
  url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response("<rss/>", { status: 200 })
);

const lib = await import("../../../scripts/verify-feeds.mts");
import { FEEDS } from "@/config/feeds";
import { COUNTRY_FEEDS } from "@/config/countries";

const FEED = { topic: "Countries/Kenya", source: "X", url: "https://a.example/feed" };

function goodItems(n: number): Record<string, unknown>[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    title: `Story ${i}`,
    link: `https://example.com/${i}`,
    isoDate: new Date(now - (i + 1) * 3_600_000).toISOString(),
    contentSnippet: "A real summary of the story with more than forty characters in it.",
  }));
}

beforeEach(() => {
  lib.robotsCache.clear();
  state.parse = async () => ({ title: "Feed", items: goodItems(5) });
});

describe("non-string title and link", () => {
  it("passes a clean feed (control)", async () => {
    expect((await lib.checkFeed(FEED)).pass).toBe(true);
  });

  for (const [label, value] of [
    ["number", 42],
    ["array", ["Story"]],
    ["object", { _: "Story" }],
    ["boolean", true],
    ["whitespace", "   \n "],
    ["null", null],
  ] as const) {
    it(`fails a ${label} title without throwing`, async () => {
      const items = goodItems(5);
      items[2].title = value;
      state.parse = async () => ({ title: "Feed", items });
      const r = await lib.checkFeed(FEED);
      expect(r.pass).toBe(false);
      expect(r.reason).toContain("1 untitled items");
    });

    it(`fails a ${label} link without throwing`, async () => {
      const items = goodItems(5);
      items[4].link = value;
      state.parse = async () => ({ title: "Feed", items });
      const r = await lib.checkFeed(FEED);
      expect(r.pass).toBe(false);
      expect(r.reason).toContain("1 items without a link");
    });
  }

  it("does not throw when the feed's own title parsed as an object", async () => {
    state.parse = async () => ({ title: { _: "Feed", $: { type: "html" } }, items: goodItems(5) });
    await expect(lib.checkFeed(FEED)).resolves.toBeDefined();
  });

  it("does not throw when an item's snippet parsed as an object", async () => {
    const items = goodItems(5);
    items[0].contentSnippet = undefined;
    items[0].content = { _: "x" };
    state.parse = async () => ({ title: "Feed", items });
    await expect(lib.checkFeed(FEED)).resolves.toBeDefined();
  });

  it("runAll survives one feed whose title is not text, reporting every feed", async () => {
    const items = goodItems(5);
    items[0].title = { _: "x" };
    state.parse = async (url: string) => ({ title: "Feed", items: url.includes("bad") ? items : goodItems(5) });
    const results = await lib.runAll([FEED, { ...FEED, url: "https://bad.example/feed" }]);
    expect(results.map((r) => r.pass)).toEqual([true, false]);
  });
});

describe("catalogFeeds", () => {
  it("lists topic feeds first, then country feeds, with no (label, source) pair twice", () => {
    const feeds = lib.catalogFeeds();
    const firstCountry = feeds.findIndex((f) => f.topic.startsWith("Countries/"));
    expect(feeds.slice(firstCountry).every((f) => f.topic.startsWith("Countries/"))).toBe(true);
    const keys = feeds.map((f) => JSON.stringify([f.topic, f.source]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps Morocco the topic and Morocco the country apart", () => {
    const feeds = lib.catalogFeeds();
    expect(feeds.filter((f) => f.topic === "Morocco")).toHaveLength(Object.keys(FEEDS["Morocco"] ?? {}).length);
    expect(feeds.filter((f) => f.topic === "Countries/Morocco")).toHaveLength(
      Object.keys(COUNTRY_FEEDS["Morocco"] ?? {}).length
    );
  });

  it("every catalog entry carries a string URL", () => {
    expect(lib.catalogFeeds().filter((f) => typeof f.url !== "string" || f.url === "")).toEqual([]);
  });
});
