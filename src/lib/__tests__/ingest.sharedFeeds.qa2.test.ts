import { describe, it, expect, beforeEach, vi } from "vitest";

// QA round 2: skipping a feed URL an earlier unit already reads, probed
// against the REAL catalog (FEEDS, COUNTRY_FEEDS, COUNTRIES). Only the network
// is faked: rss-parser answers every URL with one fresh item.

const mocks = vi.hoisted(() => ({ parseURL: vi.fn() }));
vi.mock("rss-parser", () => ({
  default: class {
    parseURL = mocks.parseURL;
  },
}));

import { FEEDS } from "@/config/feeds";
import { COUNTRIES, COUNTRIES_TOPIC, COUNTRY_FEEDS } from "@/config/countries";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import {
  ingestArticles,
  ingestUnits,
  normalizeArticleUrl,
  planFeeds,
  planUnitFeeds,
  MAX_FEEDS_PER_TOPIC,
  type PlannedFeed,
} from "@/lib/ingest";
import { MAX_READING_UNITS, readingUnits, type ReadingUnit } from "@/lib/readingUnits";

const C = (name: string): ReadingUnit => ({ topic: COUNTRIES_TOPIC, subtopic: name });
const T = (name: string): ReadingUnit => ({ topic: name as Topic, subtopic: null });
const label = (f: PlannedFeed) => (f.subtopic ? `${f.subtopic}(C):${f.source}` : `${f.topic}:${f.source}`);
const gridOf = (u: ReadingUnit): Record<string, string> =>
  u.topic === COUNTRIES_TOPIC
    ? u.subtopic && Object.hasOwn(COUNTRY_FEEDS, u.subtopic)
      ? (COUNTRY_FEEDS[u.subtopic] as Record<string, string>)
      : {}
    : ((FEEDS[u.topic] ?? {}) as Record<string, string>);

/** Independent model of the documented rule, written from the spec, not the code. */
function reference(units: readonly ReadingUnit[], preferred: readonly Source[]): string[] {
  const keys = new Set<string>();
  const distinct: ReadingUnit[] = [];
  for (const u of units) {
    const k = `${u.topic}\u0000${u.topic === COUNTRIES_TOPIC ? (u.subtopic ?? "") : ""}`;
    if (keys.has(k)) continue;
    keys.add(k);
    distinct.push(u);
  }
  const taken = new Set<string>();
  const out: string[] = [];
  for (const u of distinct.slice(0, MAX_READING_UNITS)) {
    const entries = Object.entries(gridOf(u)).filter(([, url]) => !taken.has(normalizeArticleUrl(url) ?? url));
    const pref = entries.filter(([s]) => preferred.includes(s as Source));
    const rest = entries.filter(([s]) => !preferred.includes(s as Source));
    for (const [, url] of [...pref, ...rest].slice(0, MAX_FEEDS_PER_TOPIC)) {
      taken.add(normalizeArticleUrl(url) ?? url);
      out.push(url);
    }
  }
  return out;
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <X,>(r: () => number, xs: readonly X[], n: number): X[] => {
  const copy = [...xs];
  const out: X[] = [];
  while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(r() * copy.length), 1)[0]);
  return out;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseURL.mockImplementation(async (url: string) => ({
    items: [{ title: `item from ${url}`, link: `${url}#item`, contentSnippet: "text", isoDate: new Date().toISOString() }],
  }));
});

describe("the three overlaps named in the brief, through readingUnits (real catalog)", () => {
  it("Morocco country + Morocco Politics + Morocco Finance: three section feeds of the same outlets, each read in full", () => {
    const { read } = readingUnits(["Morocco Politics", "Morocco Finance", COUNTRIES_TOPIC] as Topic[], ["Morocco"]);
    expect(read).toEqual([T("Morocco Politics"), C("Morocco"), T("Morocco Finance")]);
    const plan = planUnitFeeds(read);
    const urls = plan.map((f) => f.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(plan.filter((f) => f.subtopic === "Morocco")).toHaveLength(MAX_FEEDS_PER_TOPIC);
    expect(plan.filter((f) => f.topic === "Morocco Politics")).toHaveLength(Object.keys(FEEDS["Morocco Politics"]).length);
    expect(plan.filter((f) => f.topic === "Morocco Finance")).toHaveLength(Object.keys(FEEDS["Morocco Finance"]).length);
  });

  it("France + French Politics: French Politics sorts first and keeps RFI (EN) and Le Monde; France reads 6 others", () => {
    const { read } = readingUnits(["French Politics", COUNTRIES_TOPIC] as Topic[], ["France"]);
    expect(read).toEqual([T("French Politics"), C("France")]);
    const plan = planUnitFeeds(read);
    const urls = plan.map((f) => f.url);
    expect(new Set(urls).size).toBe(urls.length);
    const fp = plan.filter((f) => f.topic === "French Politics").map((f) => f.source);
    const fr = plan.filter((f) => f.subtopic === "France").map((f) => f.source);
    expect(fp).toContain("RFI (EN)");
    expect(fp).toContain("Le Monde");
    expect(fr).not.toContain("RFI (EN)");
    expect(fr).not.toContain("Le Monde");
    expect(fr).toHaveLength(Math.min(MAX_FEEDS_PER_TOPIC, Object.keys(COUNTRY_FEEDS.France).length - 2));
  });

  it("South Africa + Africa: the country keeps Mail & Guardian and Daily Maverick; Africa still gets 6 slots", () => {
    const { read } = readingUnits(["Africa", COUNTRIES_TOPIC] as Topic[], ["South Africa"]);
    expect(read).toEqual([C("South Africa"), T("Africa")]);
    const plan = planUnitFeeds(read);
    const urls = plan.map((f) => f.url);
    expect(new Set(urls).size).toBe(urls.length);
    const africa = plan.filter((f) => f.topic === "Africa").map((f) => f.source);
    expect(africa).toHaveLength(MAX_FEEDS_PER_TOPIC);
    expect(africa).not.toContain("Mail & Guardian");
    expect(africa).not.toContain("Daily Maverick");
  });

  it("Africa preferring Mail & Guardian loses it to South Africa and fills from its own next preferred, then catalog order", () => {
    const units = readingUnits(["Africa", COUNTRIES_TOPIC] as Topic[], ["South Africa"]).read;
    const plan = planUnitFeeds(units, ["Mail & Guardian", "Premium Times (Nigeria)"] as Source[]);
    const africa = plan.filter((f) => f.topic === "Africa").map((f) => f.source);
    expect(africa[0]).toBe("Premium Times (Nigeria)");
    expect(africa).toHaveLength(MAX_FEEDS_PER_TOPIC);
    expect(plan.filter((f) => f.subtopic === "South Africa")[0].source).toBe("Mail & Guardian");
  });
});

describe("a feed fetched twice under two spellings of one URL", () => {
  // The planner must treat every such pair as one feed. The catalog holds
  // none today, so the scan also gets Challenge.ma's feed without its
  // trailing slash (the URL 301s to the country's `/feed/`), which keeps the
  // check from passing on an empty list.
  it("plans every pair of catalog URLs that differ only by a trailing slash, scheme, www or case as one feed", () => {
    const seen = new Map<string, string>();
    const clashes: [string, string][] = [];
    const all = [
      ...Object.values(FEEDS).flatMap((g) => Object.values(g as Record<string, string>)),
      ...Object.values(COUNTRY_FEEDS).flatMap((g) => Object.values(g as Record<string, string>)),
      "https://www.challenge.ma/feed",
    ];
    for (const url of new Set(all)) {
      const key = url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
      const prior = seen.get(key);
      if (prior !== undefined && prior !== url) clashes.push([prior, url]);
      seen.set(key, url);
    }
    expect(clashes.length).toBeGreaterThan(0);
    for (const [a, b] of clashes) {
      expect(normalizeArticleUrl(a), `${a} vs ${b}`).toBe(normalizeArticleUrl(b));
    }
  });
});

describe("lone units are untouched by the skip (real catalog)", () => {
  it("every topic and every country alone plans min(6, its feed count) distinct feeds, with and without preferences", () => {
    const units = [...TOPICS.filter((t) => t !== COUNTRIES_TOPIC).map(T), ...COUNTRIES.map(C)];
    const r = rng(7);
    for (const u of units) {
      const n = Object.keys(gridOf(u)).length;
      for (const pref of [[], pick(r, SOURCES as readonly Source[], 5), Object.keys(gridOf(u)).slice(-3) as Source[]]) {
        const plan = planUnitFeeds([u], pref);
        expect(plan, `${u.topic}/${u.subtopic}`).toHaveLength(Math.min(MAX_FEEDS_PER_TOPIC, n));
        expect(new Set(plan.map((f) => f.url)).size).toBe(plan.length);
      }
    }
  });

  it("no catalog grid lists one URL under two outlets", () => {
    const dupes: string[] = [];
    const grids = [
      ...Object.entries(FEEDS).map(([k, g]) => [k, g] as const),
      ...Object.entries(COUNTRY_FEEDS).map(([k, g]) => [`Countries/${k}`, g] as const),
    ];
    for (const [k, g] of grids) {
      const urls = Object.values(g as Record<string, string>);
      if (new Set(urls).size !== urls.length) dupes.push(k);
    }
    expect(dupes).toEqual([]);
  });
});

describe("randomised: the real catalog against an independent model", () => {
  it("2000 random profiles: matches the model, never >60 feeds, never >6 per unit, never an exact URL twice", () => {
    const r = rng(20261003);
    const topicPool = TOPICS as readonly Topic[];
    for (let i = 0; i < 2000; i++) {
      const topics = pick(r, topicPool, 1 + Math.floor(r() * 14));
      if (r() < 0.6 && !topics.includes(COUNTRIES_TOPIC as Topic)) topics.push(COUNTRIES_TOPIC as Topic);
      const countries = pick(r, COUNTRIES, Math.floor(r() * 12));
      const preferred = pick(r, SOURCES as readonly Source[], Math.floor(r() * 25));
      const { read } = readingUnits(topics, countries);
      // Shuffle sometimes, so arbitrary caller order is covered too.
      const units = r() < 0.3 ? pick(r, read, read.length) : read;
      const plan = planUnitFeeds(units, preferred);
      const ctx = JSON.stringify({ topics, countries, preferred, units });

      expect(plan.map((f) => f.url), ctx).toEqual(reference(units, preferred));
      expect(plan.length, ctx).toBeLessThanOrEqual(60);
      const perUnit = new Map<string, number>();
      for (const f of plan) perUnit.set(`${f.topic}/${f.subtopic ?? ""}`, (perUnit.get(`${f.topic}/${f.subtopic ?? ""}`) ?? 0) + 1);
      expect(Math.max(0, ...perUnit.values()), ctx).toBeLessThanOrEqual(MAX_FEEDS_PER_TOPIC);
      expect(new Set(plan.map((f) => f.url)).size, ctx).toBe(plan.length);
    }
  });

  it("the skip never lowers the number of distinct feeds read versus no skip", () => {
    const r = rng(99);
    for (let i = 0; i < 1000; i++) {
      const { read } = readingUnits(pick(r, TOPICS as readonly Topic[], 8).concat(COUNTRIES_TOPIC as Topic), pick(r, COUNTRIES, 6));
      const pref = pick(r, SOURCES as readonly Source[], 10);
      const withSkip = new Set(planUnitFeeds(read, pref).map((f) => f.url)).size;
      // No-skip baseline: each unit's own first 6 slots, then union.
      const noSkip = new Set<string>();
      for (const u of read) {
        const e = Object.entries(gridOf(u));
        const ordered = [...e.filter(([s]) => pref.includes(s as Source)), ...e.filter(([s]) => !pref.includes(s as Source))];
        for (const [, url] of ordered.slice(0, MAX_FEEDS_PER_TOPIC)) noSkip.add(url);
      }
      expect(withSkip).toBeGreaterThanOrEqual(noSkip.size);
    }
  });
});

describe("the route's planFeeds(...).length is what ingestArticles fetches (real catalog)", () => {
  it("for every overlap profile and 300 random topic lists, parseURL calls === planFeeds length, each URL once", async () => {
    const profiles: Topic[][] = [
      ["Morocco", "Morocco Politics", "Morocco Finance", COUNTRIES_TOPIC] as Topic[],
      ["French Politics", "European Union", COUNTRIES_TOPIC] as Topic[],
      ["Africa", "Middle East", "Geopolitics", COUNTRIES_TOPIC] as Topic[],
    ];
    const r = rng(3);
    for (let i = 0; i < 300; i++) profiles.push(pick(r, TOPICS as readonly Topic[], 3 + Math.floor(r() * 10)));
    for (const topics of profiles) {
      const pref = pick(r, SOURCES as readonly Source[], Math.floor(r() * 15));
      mocks.parseURL.mockClear();
      const planned = planFeeds(topics, pref);
      const articles = await ingestArticles(topics, pref, null);
      const fetched = mocks.parseURL.mock.calls.map((c) => c[0] as string);
      expect(fetched.length, JSON.stringify(topics)).toBe(planned.length);
      expect(fetched).toEqual(planned.map((f) => f.url));
      expect(new Set(fetched).size).toBe(fetched.length);
      expect(articles.some((a) => "subtopic" in a)).toBe(false);
    }
  });

  it("ingestUnits for Morocco country + Morocco Politics fetches each planned URL once and tags each outlet's section to its own unit", async () => {
    const units = readingUnits(["Morocco Politics", COUNTRIES_TOPIC] as Topic[], ["Morocco"]).read;
    const articles = await ingestUnits(units, [], null);
    const fetched = mocks.parseURL.mock.calls.map((c) => c[0] as string);
    expect(fetched).toEqual(planUnitFeeds(units).map((f) => f.url));
    const hespress = articles.filter((a) => a.source === "Hespress (EN)");
    expect(hespress).toHaveLength(2);
    expect(hespress.find((a) => a.url.includes("/politics/"))).toMatchObject({ topic: "Morocco Politics" });
    expect(hespress.find((a) => !a.url.includes("/politics/"))).toMatchObject({ topic: COUNTRIES_TOPIC, subtopic: "Morocco" });
  });
});
