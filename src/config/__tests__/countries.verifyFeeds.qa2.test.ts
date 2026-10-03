import { describe, it, expect, beforeEach, vi } from "vitest";

// QA round 2 for scripts/verify-feeds.mts: an item whose snippet is not text
// must FAIL the feed (not merely not throw), and a feed title that is not text
// reads as empty. Fake parser, fake network.

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

const FEED = { topic: "Countries/Kenya", source: "X", url: "https://a.example/feed" };
const LONG = "A real summary of the story with more than forty characters in it.";

function goodItems(n: number): Record<string, unknown>[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    title: `Story ${i}`,
    link: `https://example.com/${i}`,
    isoDate: new Date(now - (i + 1) * 3_600_000).toISOString(),
    contentSnippet: LONG,
  }));
}

beforeEach(() => {
  lib.robotsCache.clear();
  state.parse = async () => ({ title: "Feed", items: goodItems(5) });
});

describe("a snippet that is not text fails the feed", () => {
  for (const [name, patch] of [
    ["object content, no contentSnippet", { contentSnippet: undefined, content: { _: "x" } }],
    ["array contentSnippet", { contentSnippet: ["x"] }],
    ["number content, null contentSnippet", { contentSnippet: null, content: 7 }],
    ["boolean contentSnippet", { contentSnippet: true }],
  ] as const) {
    it(`fails: ${name}`, async () => {
      const items = goodItems(5);
      Object.assign(items[1], patch);
      state.parse = async () => ({ title: "Feed", items });
      const r = await lib.checkFeed(FEED);
      expect(r.pass).toBe(false);
      expect(r.reason).toContain("1 items whose text is not text");
    });
  }

  it("counts every unreadable item, not just the first", async () => {
    const items = goodItems(5);
    for (const i of [0, 2, 4]) Object.assign(items[i], { contentSnippet: undefined, content: { _: "x" } });
    state.parse = async () => ({ title: "Feed", items });
    const r = await lib.checkFeed(FEED);
    expect(r.reason).toContain("3 items whose text is not text");
  });

  it("passes when contentSnippet is text even if content parsed as an object (ingest reads contentSnippet first)", async () => {
    const items = goodItems(5);
    items[1].content = { _: "x" };
    state.parse = async () => ({ title: "Feed", items });
    const r = await lib.checkFeed(FEED);
    expect(r.reason).toBe("");
    expect(r.pass).toBe(true);
  });

  it("an item with no snippet at all is short text, not unreadable", async () => {
    const items = goodItems(5);
    items[1].contentSnippet = undefined;
    state.parse = async () => ({ title: "Feed", items });
    const r = await lib.checkFeed(FEED);
    expect(r.reason).not.toContain("not text");
    expect(r.pass).toBe(true);
  });

  it("the verdict agrees with what ingest's own expression would do: stripHtml throws exactly on the failed items", async () => {
    const items = goodItems(5);
    Object.assign(items[3], { contentSnippet: undefined, content: { $: { type: "html" } } });
    const ingestWouldThrow = items.map((it) => {
      try {
        const v = (it.contentSnippet ?? it.content ?? "") as string;
        v.replace(/<[^>]*>/g, "");
        return false;
      } catch {
        return true;
      }
    });
    expect(ingestWouldThrow).toEqual([false, false, false, true, false]);
    state.parse = async () => ({ title: "Feed", items });
    expect((await lib.checkFeed(FEED)).reason).toContain("1 items whose text is not text");
  });
});

describe("feed title that is not text", () => {
  for (const [name, title] of [
    ["object", { _: "Feed", $: { type: "html" } }],
    ["number", 12],
    ["array", ["Feed"]],
    ["null", null],
  ] as const) {
    it(`reads a ${name} feed title as empty and does not fail the feed for it`, async () => {
      state.parse = async () => ({ title, items: goodItems(5) });
      const r = await lib.checkFeed(FEED);
      expect(r.feedTitle).toBe("");
      expect(r.pass).toBe(true);
    });
  }

  it("trims a text feed title", async () => {
    state.parse = async () => ({ title: "  Kenya News \n", items: goodItems(5) });
    expect((await lib.checkFeed(FEED)).feedTitle).toBe("Kenya News");
  });
});
