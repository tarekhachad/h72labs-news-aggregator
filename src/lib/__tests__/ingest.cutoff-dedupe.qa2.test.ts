import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";

// QA round 2: the since-cutoff now runs before duplicate removal. These
// check that the reorder kept every other cutoff behaviour (ceiling, malformed
// cursor, implausibly-future cursor, honoured small skew) and that dedupe
// still applies on each of those paths. Runs on the real clock: every
// timestamp is relative to Date.now() with margins of minutes or hours, so
// nothing depends on faking time.
// Never names a topic or an outlet: everything comes from TOPICS / SOURCES / FEEDS.

const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import { ingestArticles, normalizeArticleUrl } from "@/lib/ingest";
import { FEEDS } from "@/config/feeds";
import { FUTURE_CURSOR_TOLERANCE_MS } from "@/lib/cursor";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

// One outlet that has feeds in two topics: the same piece reaching a run twice.
const OUTLET = SOURCES.find((s) => TOPICS.filter((t) => FEEDS[t as Topic]?.[s]).length >= 2) as Source;
const [T1, T2] = TOPICS.filter((t) => FEEDS[t as Topic]?.[OUTLET]) as Topic[];
const URL1 = FEEDS[T1]![OUTLET]!;
const URL2 = FEEDS[T2]![OUTLET]!;

type Item = { title: string; link: string; isoDate: string };
function serve(byUrl: Record<string, Item[]>) {
  mocks.parseURL.mockImplementation(async (url: string) => ({ items: byUrl[url] ?? [] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseURL.mockResolvedValue({ items: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("fixture sanity", () => {
  it("found an outlet with feeds in two topics", () => {
    expect(OUTLET).toBeDefined();
    expect(URL1).not.toBe(URL2);
  });
});

describe("cutoff before dedupe: a stale sighting never shadows a fresh one", () => {
  it("URL duplicate (tracking-tag variant): stale copy first, fresh copy second -> fresh survives with its own link", async () => {
    serve({
      [URL1]: [{ title: "Old headline", link: "https://ex.test/story?utm_source=rss", isoDate: ago(3 * HOUR) }],
      [URL2]: [{ title: "New headline", link: "https://ex.test/story", isoDate: ago(10 * MIN) }],
    });
    const out = await ingestArticles([T1, T2], [OUTLET], ago(HOUR));
    expect(out.map((a) => a.url)).toEqual(["https://ex.test/story"]);
    expect(out[0].topic).toBe(T2);
  });

  it("null cursor (48h ceiling): a same-title item older than the ceiling does not knock out a fresh one", async () => {
    serve({
      [URL1]: [{ title: "Weekly wrap", link: "https://ex.test/wrap-old", isoDate: ago(72 * HOUR) }],
      [URL2]: [{ title: "Weekly wrap", link: "https://ex.test/wrap-new", isoDate: ago(2 * HOUR) }],
    });
    const out = await ingestArticles([T1, T2], [OUTLET], null);
    expect(out.map((a) => a.url)).toEqual(["https://ex.test/wrap-new"]);
  });

  it("a cursor older than the ceiling: the ceiling still binds, and a pre-ceiling twin cannot shadow", async () => {
    serve({
      [URL1]: [{ title: "Recap", link: "https://ex.test/recap-a", isoDate: ago(50 * HOUR) }],
      [URL2]: [{ title: "Recap", link: "https://ex.test/recap-b", isoDate: ago(47 * HOUR) }],
    });
    const out = await ingestArticles([T1, T2], [OUTLET], ago(7 * 24 * HOUR));
    expect(out.map((a) => a.url)).toEqual(["https://ex.test/recap-b"]);
  });

  it("both fresh: still deduped, first kept (feed order), original URL kept", async () => {
    serve({
      [URL1]: [{ title: "A", link: "https://www.ex.test/a/?fbclid=1#top", isoDate: ago(20 * MIN) }],
      [URL2]: [{ title: "A again", link: "https://ex.test/a", isoDate: ago(10 * MIN) }],
    });
    const out = await ingestArticles([T1, T2], [OUTLET], ago(HOUR));
    expect(out.map((a) => a.url)).toEqual(["https://www.ex.test/a/?fbclid=1#top"]);
  });

  it("both stale: nothing", async () => {
    serve({
      [URL1]: [{ title: "Z", link: "https://ex.test/z", isoDate: ago(3 * HOUR) }],
      [URL2]: [{ title: "Z", link: "https://ex.test/z", isoDate: ago(2 * HOUR) }],
    });
    expect(await ingestArticles([T1, T2], [OUTLET], ago(HOUR))).toEqual([]);
  });

  it("the cutoff is inclusive and applies before dedupe (an item exactly at the cursor is fresh)", async () => {
    const since = ago(HOUR);
    serve({
      [URL1]: [{ title: "Edge", link: "https://ex.test/edge-old", isoDate: ago(HOUR + MIN) }],
      [URL2]: [{ title: "Edge", link: "https://ex.test/edge-at", isoDate: since }],
    });
    const out = await ingestArticles([T1, T2], [OUTLET], since);
    expect(out.map((a) => a.url)).toEqual(["https://ex.test/edge-at"]);
  });
});

describe("other cursor paths still dedupe after the reorder", () => {
  it("malformed cursor -> 48h ceiling, duplicates still removed", async () => {
    serve({
      [URL1]: [{ title: "M", link: "https://amp.ex.test/m?amp=1", isoDate: ago(30 * HOUR) }],
      [URL2]: [{ title: "M2", link: "https://ex.test/m", isoDate: ago(20 * HOUR) }],
    });
    const out = await ingestArticles([T1, T2], [OUTLET], "not-a-date");
    expect(out.map((a) => a.url)).toEqual(["https://amp.ex.test/m?amp=1"]);
  });

  it("implausibly-future cursor -> warns, falls back to the ceiling, duplicates still removed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serve({
      [URL1]: [{ title: "F", link: "https://ex.test/f/amp", isoDate: ago(5 * HOUR) }],
      [URL2]: [{ title: "F", link: "https://ex.test/f-other", isoDate: ago(4 * HOUR) }],
    });
    const out = await ingestArticles([T1, T2], [OUTLET], ahead(FUTURE_CURSOR_TOLERANCE_MS + HOUR));
    expect(out.map((a) => a.url)).toEqual(["https://ex.test/f/amp"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/implausibly far ahead/);
  });

  it("future cursor within skew tolerance is honoured: nothing survives, no warning, no fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serve({
      [URL1]: [{ title: "S", link: "https://ex.test/s", isoDate: ago(MIN) }],
      [URL2]: [{ title: "S2", link: "https://ex.test/s2", isoDate: ago(2 * MIN) }],
    });
    const out = await ingestArticles([T1, T2], [OUTLET], ahead(Math.floor(FUTURE_CURSOR_TOLERANCE_MS / 2)));
    expect(out).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a failing feed is skipped and the others are still cut and deduped", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.parseURL.mockImplementation(async (url: string) => {
      if (url === URL1) throw new Error("boom");
      if (url === URL2)
        return {
          items: [
            { title: "K", link: "https://ex.test/k", isoDate: ago(10 * MIN) },
            { title: "K", link: "https://ex.test/k-repost", isoDate: ago(5 * MIN) },
            { title: "Old", link: "https://ex.test/old", isoDate: ago(3 * HOUR) },
          ],
        };
      return { items: [] };
    });
    const out = await ingestArticles([T1, T2], [OUTLET], ago(HOUR));
    expect(out.map((a) => a.url)).toEqual(["https://ex.test/k"]);
    expect(err).toHaveBeenCalled();
  });
});

describe("key sanity for the fixtures above", () => {
  it("the variants used above really do share a key", () => {
    expect(normalizeArticleUrl("https://ex.test/story?utm_source=rss")).toBe(normalizeArticleUrl("https://ex.test/story"));
    expect(normalizeArticleUrl("https://amp.ex.test/m?amp=1")).toBe(normalizeArticleUrl("https://ex.test/m"));
    expect(normalizeArticleUrl("https://ex.test/f/amp")).toBe(normalizeArticleUrl("https://ex.test/f"));
  });
});
