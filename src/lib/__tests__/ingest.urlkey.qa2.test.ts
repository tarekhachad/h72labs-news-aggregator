import { describe, it, expect } from "vitest";
import { normalizeArticleUrl } from "@/lib/ingest";

// QA round 2: the hash-route and bare-/amp changes to normalizeArticleUrl.
// Looks for false merges and missed duplicates the change introduced, and
// for inconsistencies between variants the function otherwise treats as one.

const key = normalizeArticleUrl;

describe("hash routes", () => {
  it.each([
    ["#/ routes", "https://ex.test/#/article/1", "https://ex.test/#/article/2"],
    ["#!/ routes", "https://ex.test/#!/article/1", "https://ex.test/#!/article/2"],
  ])("keeps two %s apart", (_l, a, b) => {
    expect(key(a)).not.toBe(key(b));
  });

  it.each([
    ["an ordinary anchor is still dropped", "https://ex.test/a#comments", "https://ex.test/a"],
    ["tracking params in the real query are still dropped beside a hash route", "https://ex.test/?utm_source=x#/a/1", "https://ex.test/#/a/1"],
    ["www/http variants of a hash-routed page still merge", "http://www.ex.test/#/a/1", "https://ex.test/#/a/1"],
    ["percent-encoded vs raw unicode in the route", "https://ex.test/#/caf%C3%A9", "https://ex.test/#/café"],
    ["an empty fragment", "https://ex.test/a#", "https://ex.test/a"],
  ])("%s", (_l, a, b) => {
    expect(key(a)).toBe(key(b));
  });

  it("a hash-route key cannot collide with a path or query key (no raw # outside the fragment)", () => {
    expect(key("https://ex.test/a%23/b")).not.toBe(key("https://ex.test/a#/b"));
    expect(key("https://ex.test/a?x=%23/b")).not.toBe(key("https://ex.test/a?x=#/b"));
  });

  // Probes: variants the function treats as one everywhere else.
  it("a bare '#/' (the route for the page itself) is the same page as no fragment", () => {
    expect(key("https://ex.test/story#/")).toBe(key("https://ex.test/story"));
  });

  it("a trailing slash inside a hash route does not split one article in two", () => {
    expect(key("https://ex.test/#/article/1/")).toBe(key("https://ex.test/#/article/1"));
  });

  it("a slashless hashbang ('#!article-1', the AJAX-crawling form) keeps two articles apart", () => {
    expect(key("https://ex.test/#!article-1")).not.toBe(key("https://ex.test/#!article-2"));
  });
});

describe("/amp paths", () => {
  it.each([
    ["suffix", "https://ex.test/news/story/amp", "https://ex.test/news/story"],
    ["suffix with slash", "https://ex.test/news/story/amp/", "https://ex.test/news/story"],
    ["prefix", "https://ex.test/amp/news/story", "https://ex.test/news/story"],
    ["prefix and suffix", "https://ex.test/amp/news/story/amp", "https://ex.test/news/story"],
    ["single-segment suffix", "https://ex.test/story/amp", "https://ex.test/story"],
  ])("still merges the AMP copy: %s", (_l, a, b) => {
    expect(key(a)).toBe(key(b));
  });

  it("bare /amp is not the home page", () => {
    expect(key("https://ex.test/amp")).not.toBe(key("https://ex.test/"));
  });

  // Probe: every other path ignores a trailing slash (/a/ ≡ /a), and the
  // fix's stated intent is that /amp is a page, not the root.
  it("/amp/ is the same page as /amp (trailing slash ignored, as everywhere else)", () => {
    expect(key("https://ex.test/amp/")).toBe(key("https://ex.test/amp"));
  });

  it("/amp/ is not collapsed to the home page either", () => {
    expect(key("https://ex.test/amp/")).not.toBe(key("https://ex.test/"));
  });

  it("a path segment merely ending in amp is untouched", () => {
    expect(key("https://ex.test/news/stamp")).toBe("ex.test/news/stamp");
    expect(key("https://ex.test/camp/")).toBe("ex.test/camp");
  });
});
