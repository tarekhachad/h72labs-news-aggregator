import { describe, it, expect, beforeEach, vi } from "vitest";

// QA round 3: the planned-feed skip compares feeds by normalizeArticleUrl.
// These tests check the opposite direction from round 2: across the REAL
// catalog, the skip never treats two genuinely different feeds as one.
// "Genuinely different" is judged by an independent, conservative key that
// ignores only scheme, a www. prefix, host case and trailing slashes, and
// keeps path case, every query parameter, /amp segments and m./amp. hosts.

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
import { readingUnits, type ReadingUnit } from "@/lib/readingUnits";

/** Same feed only if scheme, www., host case or trailing slashes are all that differ. */
function conservativeKey(raw: string): string {
  const u = new URL(raw.trim());
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${host}${u.port ? `:${u.port}` : ""}${path}${u.search}${u.hash}`;
}

const C = (name: string): ReadingUnit => ({ topic: COUNTRIES_TOPIC, subtopic: name });
const T = (name: string): ReadingUnit => ({ topic: name as Topic, subtopic: null });
const gridOf = (u: ReadingUnit): [Source, string][] =>
  Object.entries(
    u.topic === COUNTRIES_TOPIC
      ? u.subtopic && Object.hasOwn(COUNTRY_FEEDS, u.subtopic)
        ? COUNTRY_FEEDS[u.subtopic]
        : {}
      : (FEEDS[u.topic] ?? {})
  ) as [Source, string][];
const unitOf = (f: PlannedFeed) => `${f.topic}/${f.subtopic ?? ""}`;
const unitKey = (u: ReadingUnit) => `${u.topic}/${u.subtopic ?? ""}`;

const ALL_UNITS: ReadingUnit[] = [...TOPICS.filter((t) => t !== COUNTRIES_TOPIC).map(T), ...COUNTRIES.map(C)];
const ALL_URLS = [...new Set(ALL_UNITS.flatMap((u) => gridOf(u).map(([, url]) => url)))];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseURL.mockImplementation(async (url: string) => ({
    items: [{ title: `item from ${url}`, link: `${url}#item`, contentSnippet: "text", isoDate: new Date().toISOString() }],
  }));
});

describe("feed identity never merges two different catalog feeds", () => {
  it("every catalog URL is a parseable http(s) URL, so the identity key is never the raw-string fallback", () => {
    const bad = ALL_URLS.filter((url) => {
      try {
        return !/^https?:$/.test(new URL(url).protocol) || url !== url.trim();
      } catch {
        return true;
      }
    });
    expect(bad).toEqual([]);
  });

  it("two catalog URLs share a normalised key only when the conservative key says they are the same feed", () => {
    const byKey = new Map<string, string[]>();
    for (const url of ALL_URLS) {
      const k = normalizeArticleUrl(url) ?? url;
      byKey.set(k, [...(byKey.get(k) ?? []), url]);
    }
    const merged = [...byKey.values()].filter((urls) => urls.length > 1);
    // Not vacuous: the catalog does hold the Challenge.ma `/feed` vs `/feed/` pair.
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.flat()).toContain("https://www.challenge.ma/feed/");
    const wrong = merged.filter((urls) => new Set(urls.map(conservativeKey)).size > 1);
    expect(wrong, JSON.stringify(wrong, null, 2)).toEqual([]);
  });

  it("feeds that differ only by a query value (sport, category, path) keep distinct keys", () => {
    const groups = new Map<string, string[]>();
    for (const url of ALL_URLS.filter((u) => u.includes("?"))) {
      const base = url.split("?")[0];
      groups.set(base, [...(groups.get(base) ?? []), url]);
    }
    const siblings = [...groups.values()].filter((g) => g.length > 1);
    expect(siblings.length).toBeGreaterThanOrEqual(3); // rotowire, L'Equipe, CNA
    for (const g of siblings) {
      expect(new Set(g.map((u) => normalizeArticleUrl(u))).size, g.join(" ")).toBe(g.length);
    }
  });
});

describe("the skip, checked pairwise over every unit in the real catalog", () => {
  // For each ordered pair (a, b): a plans exactly what it plans alone, b skips
  // only feeds the conservative key says a already reads, and b still fills
  // min(6, what's left) slots. Independent of normalizeArticleUrl, so a
  // normaliser that merges too much goes red here even if every model built
  // on the normaliser moves with it.
  for (const withPrefs of [false, true]) {
    it(`every ordered pair of units${withPrefs ? " (random preferred outlets)" : ""}`, () => {
      const r = rng(withPrefs ? 4242 : 1);
      const failures: string[] = [];
      let pairs = 0;
      for (const a of ALL_UNITS) {
        for (const b of ALL_UNITS) {
          if (a === b) continue;
          const pref = withPrefs
            ? SOURCES.filter(() => r() < 0.05).concat(gridOf(b).slice(-2).map(([s]) => s))
            : [];
          const plan = planUnitFeeds([a, b], pref as Source[]);
          const aPlan = plan.filter((f) => unitOf(f) === unitKey(a));
          const bPlan = plan.filter((f) => unitOf(f) === unitKey(b));
          pairs++;
          const alone = planUnitFeeds([a], pref as Source[]);
          if (JSON.stringify(aPlan) !== JSON.stringify(alone)) failures.push(`${unitKey(a)} changed by ${unitKey(b)}`);
          const taken = new Set(aPlan.map((f) => conservativeKey(f.url)));
          const left = gridOf(b).filter(([, url]) => !taken.has(conservativeKey(url)));
          if (bPlan.length !== Math.min(MAX_FEEDS_PER_TOPIC, left.length))
            failures.push(`${unitKey(a)} -> ${unitKey(b)}: planned ${bPlan.length}, expected ${Math.min(MAX_FEEDS_PER_TOPIC, left.length)}`);
          if (bPlan.some((f) => taken.has(conservativeKey(f.url))))
            failures.push(`${unitKey(a)} -> ${unitKey(b)}: read a feed ${unitKey(a)} already reads`);
          if (plan.length > 2 * MAX_FEEDS_PER_TOPIC) failures.push(`${unitKey(a)}+${unitKey(b)}: ${plan.length} feeds`);
        }
      }
      expect(pairs).toBeGreaterThan(20_000);
      expect(failures.slice(0, 20), `${failures.length} failures`).toEqual([]);
    });
  }
});

describe("profiles built on the catalog's shared feeds", () => {
  const overlapTopics = [
    "Tech/AI",
    "Consumer Tech & Gadgets",
    "Climate & Environment",
    "Energy Transition & Renewables",
    "Automotive",
    "US Finance",
    "World Finance",
    "Markets & Investing",
    "Economy",
    "Personal Finance",
  ] as Topic[];

  it("these topic names exist (guards the test itself)", () => {
    for (const t of overlapTopics) expect(TOPICS).toContain(t);
  });

  it("ten topics that share Bloomberg, BBC, Economist, CBS, Engadget, Carbon Brief, InsideEVs: each shared feed fetched once, later topics fill from what is left, fetches === planFeeds", async () => {
    const planned = planFeeds(overlapTopics, []);
    const articles = await ingestArticles(overlapTopics, [], null);
    const fetched = mocks.parseURL.mock.calls.map((c) => c[0] as string);
    expect(fetched).toEqual(planned.map((f) => f.url));
    expect(new Set(fetched.map(conservativeKey)).size).toBe(fetched.length);
    expect(fetched.filter((u) => u === "https://feeds.bloomberg.com/markets/news.rss")).toHaveLength(1);
    // Expected total from the conservative key, unit by unit in curated order:
    // each unit reads min(6, its feeds no earlier unit already reads).
    const taken = new Set<string>();
    let expected = 0;
    for (const u of readingUnits(overlapTopics, []).read) {
      const left = gridOf(u).filter(([, url]) => !taken.has(conservativeKey(url)));
      const n = Math.min(MAX_FEEDS_PER_TOPIC, left.length);
      expected += n;
      expect(planned.filter((f) => f.topic === u.topic), u.topic).toHaveLength(n);
      for (const f of planned.filter((f) => f.topic === u.topic)) taken.add(conservativeKey(f.url));
    }
    expect(planned.length).toBe(expected);
    expect(expected).toBe(52);
    expect(articles).toHaveLength(expected);
    expect(articles.some((a) => "subtopic" in a)).toBe(false);
  });

  it("Morocco topic + Morocco country with Challenge.ma preferred: Challenge.ma fetched once, country's article", async () => {
    const units = readingUnits(["Morocco", COUNTRIES_TOPIC] as Topic[], ["Morocco"]).read;
    expect(units.map(unitKey)).toEqual(["Countries/Morocco", "Morocco/"]);
    const articles = await ingestUnits(units, ["Challenge.ma"] as Source[], null);
    const fetched = mocks.parseURL.mock.calls.map((c) => c[0] as string);
    expect(fetched.filter((u) => u.includes("challenge.ma"))).toEqual(["https://www.challenge.ma/feed/"]);
    const ch = articles.filter((a) => a.source === "Challenge.ma");
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ topic: COUNTRIES_TOPIC, subtopic: "Morocco" });
    // The topic still fills its 6 slots from what the country left.
    expect(planUnitFeeds(units, ["Challenge.ma"] as Source[]).filter((f) => f.topic === "Morocco")).toHaveLength(
      Math.min(MAX_FEEDS_PER_TOPIC, gridOf(T("Morocco")).filter(([, url]) => !planUnitFeeds([units[0]], ["Challenge.ma"] as Source[]).some((f) => conservativeKey(f.url) === conservativeKey(url))).length)
    );
  });
});
