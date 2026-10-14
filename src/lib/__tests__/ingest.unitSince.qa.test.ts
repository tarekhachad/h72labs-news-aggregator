import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// QA: per-unit cutoffs where they meet feed ownership (a feed shared by a
// topic and a country is read once, for the earlier unit, and cut at THAT
// unit's time), and per-unit values that are malformed or out of range.
const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import { ingestUnits, planUnitFeeds } from "@/lib/ingest";
import { unitKey, type ReadingUnit } from "@/lib/readingUnits";
import { COUNTRIES_TOPIC } from "@/config/countries";
import type { Article, Topic } from "@/types";

const NOW = "2026-10-09T12:00:00Z";
const HOURS = 60 * 60 * 1000;
const AGES = [1, 5, 20, 47];

function hoursAgo(hours: number): string {
  return new Date(new Date(NOW).getTime() - hours * HOURS).toISOString();
}

const SOUTH_AFRICA: ReadingUnit = { topic: COUNTRIES_TOPIC as Topic, subtopic: "South Africa" };
const AFRICA: ReadingUnit = { topic: "Africa", subtopic: null };
const TECH: ReadingUnit = { topic: "Tech/AI", subtopic: null };

// The feed South Africa (COUNTRY_FEEDS) and Africa (FEEDS) both read in their
// first six. South Africa comes first in reading order (Countries sits before
// the regional topics in TOPICS), so it owns the feed.
const SHARED = ["https://mg.co.za/rss/"];

function ages(articles: Article[], pred: (a: Article) => boolean): number[] {
  return [...new Set(articles.filter(pred).map((a) => Number(a.title.split("|")[1])))].sort((x, y) => x - y);
}
const fromFeed = (url: string) => (a: Article) => a.title.startsWith(`${url}|`);
const ofUnit = (u: ReadingUnit) => (a: Article) => a.topic === u.topic && (a.subtopic || null) === u.subtopic;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  mocks.parseURL.mockImplementation(async (url: string) => ({
    items: AGES.map((h) => ({
      title: `${url}|${h}`,
      contentSnippet: "snippet",
      link: `https://example.com/${encodeURIComponent(url)}/${h}`,
      isoDate: hoursAgo(h),
    })),
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shared feeds and per-unit cutoffs", () => {
  it("plans the shared feed once, owned by South Africa (the earlier unit)", () => {
    const plan = planUnitFeeds([SOUTH_AFRICA, AFRICA]);
    for (const url of SHARED) {
      const owners = plan.filter((f) => f.url === url);
      expect(owners).toHaveLength(1);
      expect(owners[0].subtopic).toBe("South Africa");
    }
  });

  it("a NEW topic whose shared feed is owned by an OLD country gets only the country's recent slice of it", async () => {
    const unitSince = new Map<string, string | null>([
      [unitKey(SOUTH_AFRICA.topic, SOUTH_AFRICA.subtopic), hoursAgo(6)],
      [unitKey(AFRICA.topic, null), null],
    ]);
    const articles = await ingestUnits([SOUTH_AFRICA, AFRICA], [], hoursAgo(6), unitSince);

    for (const url of SHARED) {
      // Read for South Africa, cut at South Africa's 6h, tagged South Africa.
      expect(ages(articles, fromFeed(url))).toEqual([1, 5]);
      expect(articles.filter(fromFeed(url)).every(ofUnit(SOUTH_AFRICA))).toBe(true);
    }
    // Africa's own (unshared) feeds still read the full window.
    expect(ages(articles, ofUnit(AFRICA))).toEqual([1, 5, 20, 47]);
    const africaFeeds = new Set(articles.filter(ofUnit(AFRICA)).map((a) => a.title.split("|")[0]));
    for (const url of SHARED) expect(africaFeeds.has(url)).toBe(false);
  });

  it("an OLD topic cannot drag an earlier NEW country's shared feed back: the new country owns it and reads 48h", async () => {
    const unitSince = new Map<string, string | null>([
      [unitKey(SOUTH_AFRICA.topic, SOUTH_AFRICA.subtopic), null],
      [unitKey(AFRICA.topic, null), hoursAgo(6)],
    ]);
    const articles = await ingestUnits([SOUTH_AFRICA, AFRICA], [], hoursAgo(6), unitSince);
    for (const url of SHARED) expect(ages(articles, fromFeed(url))).toEqual([1, 5, 20, 47]);
    expect(ages(articles, ofUnit(AFRICA))).toEqual([1, 5]);
  });

  it("the same article URL in an old unit's feed and a new unit's feed survives once, under the new unit", async () => {
    // Every feed now carries the SAME links, so cross-feed URL dedupe applies.
    mocks.parseURL.mockImplementation(async (url: string) => ({
      items: AGES.map((h) => ({
        title: `${url}|${h}`,
        contentSnippet: "snippet",
        link: `https://example.com/shared/${h}`,
        isoDate: hoursAgo(h),
      })),
    }));
    const unitSince = new Map<string, string | null>([
      [unitKey(TECH.topic, null), hoursAgo(6)],
      [unitKey("Space", null), null],
    ]);
    const SPACE: ReadingUnit = { topic: "Space", subtopic: null };
    const articles = await ingestUnits([TECH, SPACE], [], hoursAgo(6), unitSince);
    // 1h and 5h are seen first under Tech (earlier unit); 20h and 47h were
    // cut from Tech's copy, so Space's copy is the first sighting.
    expect(ages(articles, ofUnit(TECH))).toEqual([1, 5]);
    expect(ages(articles, ofUnit(SPACE))).toEqual([20, 47]);
  });
});

describe("per-unit values", () => {
  it("a malformed per-unit time reads the full window for that unit only", async () => {
    const unitSince = new Map<string, string | null>([
      [unitKey(TECH.topic, null), "not a date"],
      [unitKey(AFRICA.topic, null), hoursAgo(6)],
    ]);
    const articles = await ingestUnits([TECH, AFRICA], [], hoursAgo(6), unitSince);
    expect(ages(articles, ofUnit(TECH))).toEqual([1, 5, 20, 47]);
    expect(ages(articles, ofUnit(AFRICA))).toEqual([1, 5]);
  });

  it("an empty-string per-unit time behaves as never read", async () => {
    const unitSince = new Map<string, string | null>([[unitKey(TECH.topic, null), ""]]);
    const articles = await ingestUnits([TECH], [], hoursAgo(6), unitSince);
    expect(ages(articles, ofUnit(TECH))).toEqual([1, 5, 20, 47]);
  });

  it("ordinary skew in a per-unit time (2 minutes ahead) is honoured: the unit reads nothing", async () => {
    const ahead = new Date(new Date(NOW).getTime() + 2 * 60 * 1000).toISOString();
    const unitSince = new Map<string, string | null>([[unitKey(TECH.topic, null), ahead]]);
    const articles = await ingestUnits([TECH], [], hoursAgo(6), unitSince);
    expect(ages(articles, ofUnit(TECH))).toEqual([]);
  });

  it("a per-unit time later than the run cursor wins over it (the unit's own time is used, not the older cursor)", async () => {
    const unitSince = new Map<string, string | null>([[unitKey(TECH.topic, null), hoursAgo(3)]]);
    const articles = await ingestUnits([TECH], [], hoursAgo(30), unitSince);
    expect(ages(articles, ofUnit(TECH))).toEqual([1]);
  });

  it("a per-unit time OLDER than the run cursor reads further back than the run cursor would (re-added unit)", async () => {
    const unitSince = new Map<string, string | null>([[unitKey(TECH.topic, null), hoursAgo(30)]]);
    const articles = await ingestUnits([TECH], [], hoursAgo(3), unitSince);
    expect(ages(articles, ofUnit(TECH))).toEqual([1, 5, 20]);
  });

  it("an empty map reads every unit from the run cursor (map present, no entries)", async () => {
    const articles = await ingestUnits([TECH], [], hoursAgo(6), new Map());
    expect(ages(articles, ofUnit(TECH))).toEqual([1, 5]);
  });
});
