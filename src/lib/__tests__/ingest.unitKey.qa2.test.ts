import { describe, it, expect, beforeEach, vi } from "vitest";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";

// QA round 2: units are deduped on [topic, subtopic only for Countries], and
// a URL an earlier unit planned is skipped. Synthetic catalog, so each overlap
// is placed deliberately.

const mocks = vi.hoisted(() => ({
  parseURL: vi.fn(),
  feeds: {} as Record<string, Record<string, string>>,
  countryFeeds: {} as Record<string, Record<string, string>>,
  countries: [] as string[],
}));
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));
vi.mock("@/config/feeds", () => ({ FEEDS: mocks.feeds }));
vi.mock("@/config/countries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/countries")>()),
  COUNTRIES: mocks.countries,
  COUNTRY_FEEDS: mocks.countryFeeds,
}));

import { ingestUnits, planUnitFeeds, MAX_FEEDS_PER_TOPIC } from "@/lib/ingest";
import { type ReadingUnit } from "@/lib/readingUnits";
import { COUNTRIES_TOPIC } from "@/config/countries";

const S = (i: number) => SOURCES[i] as Source;
const tUrl = (t: string, s: Source) => `https://feeds.test/t/${encodeURIComponent(t)}/${encodeURIComponent(s)}`;
const cUrl = (c: string, s: Source) => `https://feeds.test/c/${encodeURIComponent(c)}/${encodeURIComponent(s)}`;
const C = (name: string): ReadingUnit => ({ topic: COUNTRIES_TOPIC, subtopic: name });
const T = (name: string, subtopic: string | null = null): ReadingUnit => ({ topic: name as Topic, subtopic });
const AFRICA = "Africa";
const EU = "European Union";

function fill(each = 9) {
  for (const grid of [mocks.feeds, mocks.countryFeeds]) for (const k of Object.keys(grid)) delete grid[k];
  for (const t of TOPICS) {
    mocks.feeds[t] = {};
    if (t === COUNTRIES_TOPIC) continue;
    for (let s = 0; s < each; s++) mocks.feeds[t][S(s)] = tUrl(t, S(s));
  }
  for (const n of ["A", "B", "C"]) {
    mocks.countryFeeds[n] = {};
    for (let s = 0; s < each; s++) mocks.countryFeeds[n][S(s)] = cUrl(n, S(s));
  }
  mocks.countries.splice(0, mocks.countries.length, "A", "B", "C");
}

beforeEach(() => {
  vi.clearAllMocks();
  fill();
  mocks.parseURL.mockImplementation(async (url: string) => ({
    items: [{ title: url, link: `${url}/i`, contentSnippet: "x", isoDate: new Date().toISOString() }],
  }));
});

describe("unit key", () => {
  it("a topic with a stray subtopic is the same unit as the plain topic, in either order", () => {
    for (const units of [
      [T(AFRICA), T(AFRICA, "Kenya")],
      [T(AFRICA, "Kenya"), T(AFRICA)],
      [T(AFRICA, "x"), T(AFRICA, "y")],
    ]) {
      const plan = planUnitFeeds(units);
      expect(plan).toHaveLength(MAX_FEEDS_PER_TOPIC);
      expect(plan.every((f) => !("subtopic" in f))).toBe(true);
    }
  });

  it("a duplicated topic doesn't push a later real unit past the 10-unit cap", () => {
    const ten = TOPICS.filter((t) => t !== COUNTRIES_TOPIC).slice(0, 10);
    const units = [T(ten[0]), T(ten[0], "junk"), ...ten.slice(1).map((t) => T(t))];
    const plan = planUnitFeeds(units);
    expect(new Set(plan.map((f) => f.topic))).toEqual(new Set(ten));
    expect(plan).toHaveLength(60);
  });

  it("two different countries stay two units; the same country twice is one", () => {
    expect(planUnitFeeds([C("A"), C("B")])).toHaveLength(12);
    expect(planUnitFeeds([C("A"), C("A")])).toHaveLength(6);
  });

  it("a country named like a topic is a different unit from that topic", () => {
    mocks.countryFeeds[AFRICA] = { [S(0)]: cUrl(AFRICA, S(0)), [S(1)]: cUrl(AFRICA, S(1)), [S(2)]: cUrl(AFRICA, S(2)) };
    const plan = planUnitFeeds([C(AFRICA), T(AFRICA)]);
    expect(plan.filter((f) => f.subtopic === AFRICA)).toHaveLength(3);
    expect(plan.filter((f) => f.topic === AFRICA)).toHaveLength(6);
  });
});

describe("skipping a URL an earlier unit planned", () => {
  it("only skips URLs that were actually planned, not the earlier unit's unread tail", () => {
    // Country A's 9th feed (never in its 6 slots) is also Africa's first.
    mocks.feeds[AFRICA] = { [S(0)]: cUrl("A", S(8)), ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [S(i), tUrl(AFRICA, S(i))])) };
    const plan = planUnitFeeds([C("A"), T(AFRICA)]);
    expect(plan.filter((f) => f.topic === AFRICA).map((f) => f.url)[0]).toBe(cUrl("A", S(8)));
  });

  it("a lone unit is unaffected even when another topic shares all its feeds", () => {
    mocks.feeds[EU] = { ...mocks.feeds[AFRICA] };
    expect(planUnitFeeds([T(EU)])).toHaveLength(6);
    expect(planUnitFeeds([T(AFRICA)])).toHaveLength(6);
  });

  it("a later unit whose every feed was taken reads nothing, and the total stays the union", () => {
    mocks.feeds[EU] = Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [S(i), tUrl(AFRICA, S(i))]));
    const plan = planUnitFeeds([T(AFRICA), T(EU)]);
    expect(plan).toHaveLength(6);
    expect(plan.every((f) => f.topic === AFRICA)).toBe(true);
  });

  it("a preferred outlet the earlier unit already took doesn't take the later unit's slot; the next preferred one does", () => {
    // B shares its S(5) feed with A.
    mocks.countryFeeds.B[S(5)] = cUrl("A", S(5));
    const plan = planUnitFeeds([C("A"), C("B")], [S(5), S(7)]);
    const b = plan.filter((f) => f.subtopic === "B").map((f) => f.source);
    expect(b).toEqual([7, 0, 1, 2, 3, 4].map(S));
    const a = plan.filter((f) => f.subtopic === "A").map((f) => f.source);
    expect(a).toEqual([5, 7, 0, 1, 2, 3].map(S));
  });

  it("chains across three units: each later unit skips everything any earlier one planned", () => {
    mocks.countryFeeds.B = Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [S(i), i < 3 ? cUrl("A", S(i)) : cUrl("B", S(i))]));
    mocks.countryFeeds.C = Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => [S(i), i < 6 ? cUrl("B", S(i)) : cUrl("C", S(i))]));
    const plan = planUnitFeeds([C("A"), C("B"), C("C")]);
    const urls = plan.map((f) => f.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(plan.filter((f) => f.subtopic === "B")).toHaveLength(5);
    // C lists B's S(0..5) URLs; only S(3..5) of those were planned (B's S(0..2) slots hold A's URLs).
    // So C skips S(3..5) and fills from S(6..8).
    expect(plan.filter((f) => f.subtopic === "C").map((f) => f.source)).toEqual([0, 1, 2, 6, 7, 8].map(S));
  });

  it("ingestUnits fetches the shared URL once and the article goes to the earlier unit", async () => {
    mocks.feeds[AFRICA][S(0)] = cUrl("A", S(0));
    const articles = await ingestUnits([C("A"), T(AFRICA)], [], null);
    const fetched = mocks.parseURL.mock.calls.map((c) => c[0]);
    expect(fetched.filter((u) => u === cUrl("A", S(0)))).toHaveLength(1);
    expect(fetched).toHaveLength(12);
    const shared = articles.filter((a) => a.url === `${cUrl("A", S(0))}/i`);
    expect(shared).toEqual([expect.objectContaining({ topic: COUNTRIES_TOPIC, subtopic: "A" })]);
  });
});
