import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Per-unit cutoffs: each reading unit can be read from its own time, so a
// topic picked since the last run reads the full lookback window while the
// rest read only what is new. rss-parser is mocked, so ingestUnits is a pure
// function of (feed items, cursors, now).
const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));

vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import { ingestUnits } from "@/lib/ingest";
import { unitKey, type ReadingUnit } from "@/lib/readingUnits";
import { COUNTRIES_TOPIC } from "@/config/countries";
import type { Article, Topic } from "@/types";

const NOW = "2026-10-09T12:00:00Z";
const HOURS = 60 * 60 * 1000;
const AGES = [1, 5, 20, 47];

function hoursAgo(hours: number): string {
  return new Date(new Date(NOW).getTime() - hours * HOURS).toISOString();
}

const TECH: ReadingUnit = { topic: "Tech/AI", subtopic: null };
const SPACE: ReadingUnit = { topic: "Space", subtopic: null };
const FRANCE: ReadingUnit = { topic: COUNTRIES_TOPIC as Topic, subtopic: "France" };

/** Survivors of one unit, as ages in hours, smallest first and each once. */
function agesOf(articles: Article[], unit: ReadingUnit): number[] {
  const ages = articles
    .filter((a) => a.topic === unit.topic && (a.subtopic || null) === unit.subtopic)
    .map((a) => Number(a.title.split("|")[1]));
  return [...new Set(ages)].sort((x, y) => x - y);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  // Every feed returns one article per age. The title carries the feed URL so
  // the same headline from one outlet in two feeds isn't merged as a repeat.
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

describe("ingestUnits with per-unit read times", () => {
  it("reads a unit from its own time and a never-read unit from the full window", async () => {
    const unitSince = new Map([
      [unitKey(TECH.topic, TECH.subtopic), hoursAgo(6)],
      [unitKey(SPACE.topic, SPACE.subtopic), null],
    ]);
    const articles = await ingestUnits([TECH, SPACE], [], hoursAgo(6), unitSince);

    expect(agesOf(articles, TECH)).toEqual([1, 5]);
    expect(agesOf(articles, SPACE)).toEqual([1, 5, 20, 47]);
  });

  it("falls back to the run cursor for a unit the map doesn't mention", async () => {
    const unitSince = new Map([[unitKey(SPACE.topic, SPACE.subtopic), null]]);
    const articles = await ingestUnits([TECH, SPACE], [], hoursAgo(6), unitSince);

    expect(agesOf(articles, TECH)).toEqual([1, 5]);
    expect(agesOf(articles, SPACE)).toEqual([1, 5, 20, 47]);
  });

  it("keys a country by its subtopic, so it can be new while the topics are not", async () => {
    const unitSince = new Map<string, string | null>([
      [unitKey(TECH.topic, TECH.subtopic), hoursAgo(6)],
      [unitKey(FRANCE.topic, FRANCE.subtopic), null],
    ]);
    const articles = await ingestUnits([TECH, FRANCE], [], hoursAgo(6), unitSince);

    expect(agesOf(articles, TECH)).toEqual([1, 5]);
    expect(agesOf(articles, FRANCE)).toEqual([1, 5, 20, 47]);
  });

  it("without a map, reads every unit from the run cursor, as before", async () => {
    const articles = await ingestUnits([TECH, SPACE], [], hoursAgo(6));

    expect(agesOf(articles, TECH)).toEqual([1, 5]);
    expect(agesOf(articles, SPACE)).toEqual([1, 5]);
  });

  it("treats a unit time implausibly far in the future as corrupt and reads the full window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const farFuture = new Date(new Date(NOW).getTime() + 30 * 24 * HOURS).toISOString();
    const unitSince = new Map([[unitKey(TECH.topic, TECH.subtopic), farFuture]]);
    const articles = await ingestUnits([TECH], [], hoursAgo(6), unitSince);

    expect(agesOf(articles, TECH)).toEqual([1, 5, 20, 47]);
  });

  it("still clamps an old unit time to the 48h ceiling", async () => {
    mocks.parseURL.mockImplementation(async (url: string) => ({
      items: [1, 47, 49, 100].map((h) => ({
        title: `${url}|${h}`,
        contentSnippet: "snippet",
        link: `https://example.com/${encodeURIComponent(url)}/${h}`,
        isoDate: hoursAgo(h),
      })),
    }));
    const unitSince = new Map([[unitKey(TECH.topic, TECH.subtopic), hoursAgo(168)]]);
    const articles = await ingestUnits([TECH], [], hoursAgo(6), unitSince);

    expect(agesOf(articles, TECH)).toEqual([1, 47]);
  });
});
