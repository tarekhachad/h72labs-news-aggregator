import { describe, it, expect } from "vitest";
import { dedupeArticles, normalizeArticleUrl } from "@/lib/ingest";
import { SOURCES, TOPICS, type Article, type Source, type Topic } from "@/types";

// QA round 3: the trailing-slash-before-AMP and hash-route normalisation in
// normalizeArticleUrl. Cases already covered by the round-1/2 files are not
// repeated here. Never names a topic or an outlet.

const key = normalizeArticleUrl;
const TOPIC = TOPICS[0] as Topic;
const [OUTLET] = SOURCES as readonly Source[];

function article(url: string, title: string): Article {
  return { title, snippet: "", url, source: OUTLET, topic: TOPIC, publishedAt: "2026-10-02T12:00:00Z" };
}

describe("AMP markers after the trailing slash is stripped: exact keys", () => {
  it.each([
    ["https://ex.test/x/amp/", "ex.test/x"],
    ["https://ex.test/x/amp//", "ex.test/x"],
    ["https://ex.test/amp/x", "ex.test/x"],
    ["https://ex.test/amp/x/", "ex.test/x"],
    ["https://ex.test/amp", "ex.test/amp"],
    ["https://ex.test/amp//", "ex.test/amp"],
    ["https://ex.test/", "ex.test/"],
  ])("%s keys as %s", (url, expected) => {
    expect(key(url)).toBe(expected);
  });

  it("an /amp page with a query is still that page, not the home page with that query", () => {
    expect(key("https://ex.test/amp/?p=7")).not.toBe(key("https://ex.test/?p=7"));
  });

  it("an /amp page carrying a hash route is not the home page's hash route", () => {
    expect(key("https://ex.test/amp#/a")).not.toBe(key("https://ex.test/#/a"));
  });

  it("a hash route ending in /amp is not stripped like a path (the route is kept verbatim)", () => {
    expect(key("https://ex.test/#/a/amp")).not.toBe(key("https://ex.test/#/a"));
  });
});

describe("AMP markers: probes for new false merges and misses", () => {
  // A doubled slash before the marker leaves "/" once "/amp" is removed,
  // which is truthy, so the root fallback never fires.
  it("'//amp' is not collapsed to the site's home page", () => {
    expect(key("https://ex.test//amp")).not.toBe(key("https://ex.test/"));
  });

  it("'/x//amp' is the AMP copy of '/x' (no slash left over after the marker)", () => {
    expect(key("https://ex.test/x//amp")).toBe(key("https://ex.test/x"));
  });
});

describe("hash routes: '#!' and '#/' forms", () => {
  it.each([
    ["#!a", "#/a"],
    ["#!/a", "#/a"],
    ["#!a", "#!/a"],
    ["#//a//", "#/a"],
    ["#!//a/", "#/a"],
  ])("%s and %s name the same route", (a, b) => {
    expect(key(`https://ex.test/p${a}`)).toBe(key(`https://ex.test/p${b}`));
  });

  it.each(["#!", "#!/", "#//", "#!//"])("an empty route %s is no route at all", (frag) => {
    expect(key(`https://ex.test/p${frag}`)).toBe(key("https://ex.test/p"));
  });

  it.each([
    ["two routes on the same page", "https://ex.test/p#!a", "https://ex.test/p#!b"],
    ["one route on two pages", "https://ex.test/p#!a", "https://ex.test/q#!a"],
    ["query-style hashbang routes", "https://ex.test/#!?id=1", "https://ex.test/#!?id=2"],
    ["a route vs the same text as a path", "https://ex.test/#/a", "https://ex.test/a"],
    ["a route vs the same text under a path", "https://ex.test/x#/a", "https://ex.test/x/a"],
    ["a route under a query vs the bare route", "https://ex.test/?x=1#/a", "https://ex.test/#/a"],
    ["route case", "https://ex.test/#/A", "https://ex.test/#/a"],
    ["'#!!a' is not '#!a'", "https://ex.test/#!!a", "https://ex.test/#!a"],
  ])("keeps apart %s", (_l, a, b) => {
    expect(key(a)).not.toBe(key(b));
  });

  it("an ordinary anchor that merely contains a slash later on is still dropped", () => {
    expect(key("https://ex.test/p#section/2")).toBe(key("https://ex.test/p"));
  });
});

describe("dedupeArticles with the new keys", () => {
  it("collapses one hash-routed article seen as '#!a' and '#/a/', keeping the first link", () => {
    const out = dedupeArticles([
      article("https://ex.test/app#!a", "One headline"),
      article("https://www.ex.test/app/#/a/", "A rewritten headline"),
    ]);
    expect(out.map((a) => a.url)).toEqual(["https://ex.test/app#!a"]);
  });

  it("keeps two different hash-routed articles on one page", () => {
    const out = dedupeArticles([
      article("https://ex.test/app#!a", "First headline"),
      article("https://ex.test/app#!b", "Second headline"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps an /amp page and the home page as two articles", () => {
    const out = dedupeArticles([
      article("https://ex.test/", "Front page"),
      article("https://ex.test/amp/", "A page called amp"),
    ]);
    expect(out).toHaveLength(2);
  });
});
