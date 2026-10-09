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

const FRENCH_POLITICS: ReadingUnit = { topic: "French Politics" as Topic, subtopic: null };
const FRANCE: ReadingUnit = { topic: COUNTRIES_TOPIC as Topic, subtopic: "France" };
const TECH: ReadingUnit = { topic: "Tech/AI", subtopic: null };

// The two feeds French Politics (FEEDS) and France (COUNTRY_FEEDS) share.
const SHARED = ["https://www.rfi.fr/en/france/rss", "https://www.lemonde.fr/politique/rss_full.xml"];

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
  it("plans each shared French feed once, owned by French Politics (earlier in TOPICS than Countries)", () => {
    const plan = planUnitFeeds([FRENCH_POLITICS, FRANCE]);
    for (const url of SHARED) {
      const owners = plan.filter((f) => f.url === url);
      expect(owners).toHaveLength(1);
      expect(owners[0].topic).toBe("French Politics");
    }
  });

  it("a NEW country whose shared feeds are owned by an OLD topic gets only the topic's recent slice of them", async () => {
    const unitSince = new Map<string, string | null>([
      [unitKey(FRENCH_POLITICS.topic, null), hoursAgo(6)],
      [unitKey(FRANCE.topic, FRANCE.subtopic), null],
    ]);
    const articles = await ingestUnits([FRENCH_POLITICS, FRANCE], [], hoursAgo(6), unitSince);

    for (const url of SHARED) {
      // Read for French Politics, cut at French Politics' 6h, tagged French Politics.
      expect(ages(articles, fromFeed(url))).toEqual([1, 5]);
      expect(articles.filter(fromFeed(url)).every(ofUnit(FRENCH_POLITICS))).toBe(true);
    }
    // France's own (unshared) feeds still read the full window.
    expect(ages(articles, ofUnit(FRANCE))).toEqual([1, 5, 20, 47]);
    const franceFeeds = new Set(articles.filter(ofUnit(FRANCE)).map((a) => a.title.split("|")[0]));
    for (const url of SHARED) expect(franceFeeds.has(url)).toBe(false);
  });

  it("an OLD country cannot drag an earlier NEW topic's shared feeds back: the new topic owns them and reads 48h", async () => {
    const unitSince = new Map<string, string | null>([
      [unitKey(FRENCH_POLITICS.topic, null), null],
      [unitKey(FRANCE.topic, FRANCE.subtopic), hoursAgo(6)],
    ]);
    const articles = await ingestUnits([FRENCH_POLITICS, FRANCE], [], hoursAgo(6), unitSince);
    for (const url of SHARED) expect(ages(articles, fromFeed(url))).toEqual([1, 5, 20, 47]);
    expect(ages(articles, ofUnit(FRANCE))).toEqual([1, 5]);
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
      [unitKey(FRENCH_POLITICS.topic, null), hoursAgo(6)],
    ]);
    const articles = await ingestUnits([TECH, FRENCH_POLITICS], [], hoursAgo(6), unitSince);
    expect(ages(articles, ofUnit(TECH))).toEqual([1, 5, 20, 47]);
    expect(ages(articles, ofUnit(FRENCH_POLITICS))).toEqual([1, 5]);
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
