import { describe, it, expect, beforeEach, vi } from "vitest";

// The checks scripts/verify-feeds.mts applies before a feed may ship, run
// against a fake parser and a fake network, so each rule can be broken on
// purpose: robots.txt on every redirect hop, an unreachable robots.txt as a
// block, and the feed bar itself.

type ParsedFeed = { title?: string; items?: Record<string, unknown>[] };

const state = vi.hoisted(() => ({
  parse: (async () => ({ items: [] })) as (url: string) => Promise<ParsedFeed>,
}));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL(url: string) {
      return state.parse(url);
    }
  },
}));

type Init = { redirect?: string; headers?: Record<string, string> };
let robots: Record<string, () => Promise<Response>>;
let pages: Record<string, () => Promise<Response>>;
let calls: { url: string; init?: Init }[];

vi.stubGlobal("fetch", async (url: string, init?: Init): Promise<Response> => {
  calls.push({ url, init });
  if (url.endsWith("/robots.txt")) {
    const respond = robots[url.slice(0, -"/robots.txt".length)];
    return respond ? respond() : new Response("", { status: 404 });
  }
  const respond = pages[url];
  return respond ? respond() : new Response("<rss/>", { status: 200 });
});

const lib = await import("../../scripts/verify-feeds.mts");

const AGENT = "H72NewsAggregator";
const allows = (txt: string, path: string) => lib.robotsAllows(txt, AGENT, path);
const ok = (text: string) => async () => new Response(text, { status: 200 });
const status = (code: number) => async () => new Response("x", { status: code });
const redirect = (to: string, code = 301) => async () =>
  new Response(null, { status: code, headers: { location: to } });

function feedItems(n: number, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    title: `Story ${i}`,
    link: `https://example.com/${i}`,
    isoDate: new Date(now - (i + 1) * 3_600_000).toISOString(),
    contentSnippet: "A real summary of the story with more than forty characters in it.",
    ...overrides,
  }));
}

const FEED = { topic: "Science", source: "X", url: "https://a.example/feed?x=1" };

beforeEach(() => {
  lib.robotsCache.clear();
  robots = {};
  pages = {};
  calls = [];
  state.parse = async () => ({ title: "Feed", items: feedItems(5) });
});

describe("robots.txt rules", () => {
  it("applies the * group, the longest match wins, and Allow wins a tie", () => {
    expect(allows("User-agent: *\nDisallow: /rss", "/rss/world")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /news\nAllow: /news/feed", "/news/feed/rss")).toBe(true);
    expect(allows("User-agent: *\nDisallow: /feed\nAllow: /feed", "/feed")).toBe(true);
  });

  it("prefers a group naming our token exactly, ignoring case and version", () => {
    expect(allows("User-agent: *\nDisallow: /\n\nUser-agent: h72newsaggregator/1.0\nAllow: /", "/feed")).toBe(true);
    expect(allows("User-agent: H72\nDisallow: /\nUser-agent: *\nAllow: /", "/feed")).toBe(true);
    expect(allows("User-agent: H72NewsAggregatorPlus\nAllow: /\nUser-agent: *\nDisallow: /", "/feed")).toBe(false);
  });

  it("supports * and $ and reads other characters literally", () => {
    expect(allows("User-agent: *\nDisallow: /*.xml$", "/world/rss.xml")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /*.xml$", "/world/rss.xml?x=1")).toBe(true);
    expect(allows("User-agent: *\nDisallow: /a.b", "/axb")).toBe(true);
  });

  it("splits lines on CR, LF and CRLF", () => {
    expect(allows("User-agent: *\rDisallow: /feed", "/feed")).toBe(false);
    expect(allows("User-agent: *\r\nDisallow: /feed", "/feed")).toBe(false);
    expect(allows("User-agent: foo\rDisallow: /\rUser-agent: *\rAllow: /", "/feed")).toBe(true);
  });
});

describe("the redirect walk", () => {
  it("follows hops itself, with the parser's own headers", async () => {
    await lib.redirectChain("https://a.example/feed");
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[0].init?.headers?.Accept).toBe("application/rss+xml");
  });

  it("records every hop, resolving a relative Location against the current one", async () => {
    pages["https://a.example/feed"] = redirect("https://b.example/rss");
    pages["https://b.example/rss"] = redirect("/v2/rss.xml", 302);
    expect(await lib.redirectChain("https://a.example/feed")).toEqual({
      urls: ["https://a.example/feed", "https://b.example/rss", "https://b.example/v2/rss.xml"],
      complete: true,
    });
  });

  it("stops on a 3xx without a Location and on a non-3xx that carries one", async () => {
    pages["https://a.example/feed"] = async () => new Response(null, { status: 304 });
    expect((await lib.redirectChain("https://a.example/feed")).urls).toEqual(["https://a.example/feed"]);
    pages["https://a.example/feed"] = async () =>
      new Response("x", { status: 200, headers: { location: "https://c.example/" } });
    expect((await lib.redirectChain("https://a.example/feed")).urls).toEqual(["https://a.example/feed"]);
  });

  it("stops a redirect loop after 5 hops, as rss-parser does", async () => {
    pages["https://a.example/1"] = redirect("https://a.example/2");
    pages["https://a.example/2"] = redirect("https://a.example/1");
    expect((await lib.redirectChain("https://a.example/1")).urls).toHaveLength(6);
  });

  it("marks the walk incomplete when a hop cannot be fetched", async () => {
    pages["https://a.example/feed"] = redirect("https://b.example/rss");
    pages["https://b.example/rss"] = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await lib.redirectChain("https://a.example/feed")).toEqual({
      urls: ["https://a.example/feed", "https://b.example/rss"],
      complete: false,
    });
  });

  it("marks the walk incomplete when a Location cannot be read, without throwing", async () => {
    pages["https://a.example/feed"] = redirect("http://[bad");
    expect(await lib.redirectChain("https://a.example/feed")).toEqual({
      urls: ["https://a.example/feed"],
      complete: false,
    });
  });
});

describe("robots.txt on every hop", () => {
  it("fails a feed whose redirect lands on a host that disallows it", async () => {
    pages["https://a.example/feed?x=1"] = redirect("https://b.example/rss");
    robots["https://a.example"] = ok("User-agent: *\nAllow: /");
    robots["https://b.example"] = ok("User-agent: *\nDisallow: /");
    const result = await lib.checkFeed(FEED);
    expect(result.pass).toBe(false);
    expect(result.robots).toBe("disallowed");
  });

  it("checks each hop's own path and query", async () => {
    pages["https://a.example/feed?x=1"] = redirect("https://a.example/private/rss?id=7");
    robots["https://a.example"] = ok("User-agent: *\nDisallow: /private/rss?id=");
    expect((await lib.checkFeed(FEED)).robots).toBe("disallowed");
  });

  it("passes when every hop allows", async () => {
    pages["https://a.example/feed?x=1"] = redirect("https://b.example/rss");
    robots["https://a.example"] = ok("User-agent: *\nDisallow: /admin");
    robots["https://b.example"] = ok("User-agent: *\nDisallow: /admin");
    const result = await lib.checkFeed(FEED);
    expect(result.reason).toBe("");
    expect(result.pass).toBe(true);
  });

  it("fails when a later hop's robots.txt is unreachable", async () => {
    pages["https://a.example/feed?x=1"] = redirect("https://b.example/rss");
    robots["https://b.example"] = status(502);
    expect((await lib.checkFeed(FEED)).robots).toBe("unreachable");
  });

  it("fails when the walk could not finish, since the rest of the path is unknown", async () => {
    pages["https://a.example/feed?x=1"] = redirect("http://[bad");
    const result = await lib.checkFeed(FEED);
    expect(result.pass).toBe(false);
    expect(result.robots).toBe("unreachable");
  });

  it("lets a disallow on a later hop outrank an unreachable earlier one", async () => {
    robots["https://a.example"] = status(503);
    robots["https://b.example"] = ok("User-agent: *\nDisallow: /");
    expect(
      await lib.robotsVerdict({ urls: ["https://a.example/x", "https://b.example/y"], complete: true })
    ).toBe("disallowed");
  });

  it("fetches each host's robots.txt once", async () => {
    pages["https://a.example/feed?x=1"] = redirect("https://a.example/rss");
    await lib.runAll([FEED, { ...FEED, url: "https://a.example/other" }]);
    expect(calls.filter((c) => c.url === "https://a.example/robots.txt")).toHaveLength(1);
  });
});

describe("an unreachable robots.txt is a block, a missing one is not (RFC 9309)", () => {
  it("fails on a 5xx, including 500", async () => {
    robots["https://a.example"] = status(500);
    const result = await lib.checkFeed(FEED);
    expect(result.pass).toBe(false);
    expect(result.robots).toBe("unreachable");
  });

  it("fails when the robots.txt fetch errors or times out", async () => {
    robots["https://a.example"] = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    expect((await lib.checkFeed(FEED)).robots).toBe("unreachable");
  });

  it("treats a 4xx as no rules", async () => {
    robots["https://a.example"] = status(499);
    expect((await lib.checkFeed(FEED)).pass).toBe(true);
    lib.robotsCache.clear();
    robots["https://a.example"] = status(403);
    expect((await lib.checkFeed(FEED)).pass).toBe(true);
  });
});

describe("the feed bar", () => {
  it("passes a healthy feed", async () => {
    expect((await lib.checkFeed(FEED)).pass).toBe(true);
  });

  it("fails a feed whose newest item is over 96 hours old", async () => {
    const at = (hours: number) => async () => ({
      items: feedItems(3, { isoDate: new Date(Date.now() - hours * 3_600_000).toISOString() }),
    });
    state.parse = at(97);
    expect((await lib.checkFeed(FEED)).pass).toBe(false);
    state.parse = at(95);
    expect((await lib.checkFeed(FEED)).pass).toBe(true);
  });

  it("fails empty, undated, headline-only and untitled feeds, and parse errors", async () => {
    state.parse = async () => ({ items: [] });
    expect((await lib.checkFeed(FEED)).reason).toContain("no items");
    state.parse = async () => ({ items: feedItems(3, { isoDate: undefined }) });
    expect((await lib.checkFeed(FEED)).reason).toContain("no item dates");
    state.parse = async () => ({ items: feedItems(3, { contentSnippet: "<p>Short</p>" }) });
    expect((await lib.checkFeed(FEED)).reason).toContain("median snippet");
    state.parse = async () => ({ items: feedItems(3, { title: " " }) });
    expect((await lib.checkFeed(FEED)).reason).toContain("3 untitled items");
    state.parse = async () => {
      throw new Error("Status code 403");
    };
    expect((await lib.checkFeed(FEED)).reason).toBe("fetch/parse: Status code 403");
  });

  it("fails items without a link, since ingest dedupes by link", async () => {
    const items = feedItems(4);
    items[0].link = "";
    items[2].link = "   ";
    state.parse = async () => ({ items });
    expect((await lib.checkFeed(FEED)).reason).toContain("2 items without a link");
  });

  it("fails a title or link that parsed as something other than text, without throwing", async () => {
    const items: Record<string, unknown>[] = feedItems(3);
    items[0].title = { _: "Story", $: { type: "html" } };
    items[1].link = { $: { href: "https://example.com/1" } };
    state.parse = async () => ({ items });
    const result = await lib.checkFeed(FEED);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("1 untitled items");
    expect(result.reason).toContain("1 items without a link");
  });

  it("reports an invalid URL without fetching anything", async () => {
    const result = await lib.checkFeed({ ...FEED, url: "not a url" });
    expect(result.reason).toBe("not a valid URL");
    expect(calls).toHaveLength(0);
  });
});

describe("the catalog it checks", () => {
  it("covers every topic feed and every country feed, labelling each country's", async () => {
    const { FEEDS } = await import("@/config/feeds");
    const { COUNTRY_FEEDS } = await import("@/config/countries");
    const feeds = lib.catalogFeeds();
    const count = (grid: Record<string, Record<string, unknown>>) =>
      Object.values(grid).reduce((n, bySource) => n + Object.keys(bySource).length, 0);

    expect(feeds).toHaveLength(count(FEEDS) + count(COUNTRY_FEEDS));
    for (const [country, bySource] of Object.entries(COUNTRY_FEEDS)) {
      for (const [source, url] of Object.entries(bySource)) {
        expect(feeds).toContainEqual({ topic: `Countries/${country}`, source, url });
      }
    }
  });
});
