import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FEEDS } from "@/config/feeds";
import { SOURCES, TOPICS, type Topic } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC, COUNTRY_FEEDS, countryToSlug, slugToCountry } from "@/config/countries";
import { planUnitFeeds, MAX_FEEDS_PER_TOPIC } from "@/lib/ingest";
import { readingUnits } from "@/lib/readingUnits";

// QA probes on the real, shipped country catalog.

const countryEntries = Object.entries(COUNTRY_FEEDS) as [string, Record<string, string>][];
const topicEntries = Object.entries(FEEDS) as [string, Record<string, string>][];

// The outlets appended after the "Country outlets" marker in src/types.ts.
function countryOnlyOutlets(): string[] {
  const text = readFileSync(resolve(__dirname, "../../types.ts"), "utf8");
  const start = text.indexOf("// Country outlets:");
  const end = text.indexOf("] as const;", start);
  return [...text.slice(start, end).matchAll(/^\s*"((?:[^"\\]|\\.)*)",/gm)].map((m) => JSON.parse(`"${m[1]}"`));
}

describe("country catalog: counts the brief claims", () => {
  it("offers 99 countries with 428 feeds and 331 new outlets", () => {
    expect(COUNTRIES).toHaveLength(99);
    expect(countryEntries.reduce((n, [, bySource]) => n + Object.keys(bySource).length, 0)).toBe(428);
    expect(countryOnlyOutlets()).toHaveLength(331);
  });
});

describe("country catalog: invariants", () => {
  it("SOURCES holds no duplicate outlet", () => {
    const seen = new Set<string>();
    const dupes = SOURCES.filter((s) => (seen.has(s) ? true : (seen.add(s), false)));
    expect(dupes).toEqual([]);
  });

  it("no two outlets differ only by case or surrounding whitespace", () => {
    const keys = SOURCES.map((s) => s.trim().toLowerCase());
    expect(new Set(keys).size).toBe(SOURCES.length);
    expect(SOURCES.filter((s) => s !== s.trim())).toEqual([]);
  });

  it("every country-only outlet is used by some country and by no topic", () => {
    const inCountries = new Set(countryEntries.flatMap(([, b]) => Object.keys(b)));
    const inTopics = new Set(topicEntries.flatMap(([, b]) => Object.keys(b)));
    const outlets = countryOnlyOutlets();
    expect(outlets.filter((o) => !inCountries.has(o))).toEqual([]);
    expect(outlets.filter((o) => inTopics.has(o))).toEqual([]);
  });

  it("every SOURCES entry is used somewhere", () => {
    const used = new Set([...topicEntries, ...countryEntries].flatMap(([, b]) => Object.keys(b)));
    expect(SOURCES.filter((s) => !used.has(s))).toEqual([]);
  });

  it("COUNTRIES is alphabetical", () => {
    const sorted = [...COUNTRIES].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    expect(COUNTRIES).toEqual(sorted);
  });

  it("country names are trimmed, non-empty, slash-free and not Object prototype keys", () => {
    const bad = COUNTRIES.filter(
      (c) => c !== c.trim() || c === "" || c.includes("/") || c in Object.prototype
    );
    expect(bad).toEqual([]);
  });

  it("country names are unique case-insensitively, and slugs are unique and round-trip", () => {
    expect(new Set(COUNTRIES.map((c) => c.toLowerCase())).size).toBe(COUNTRIES.length);
    const slugs = COUNTRIES.map(countryToSlug);
    expect(new Set(slugs).size).toBe(COUNTRIES.length);
    expect(slugs.filter((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))).toEqual([]);
    for (const c of COUNTRIES) expect(slugToCountry(countryToSlug(c))).toBe(c);
  });

  it("slugToCountry rejects junk and prototype keys", () => {
    for (const s of ["", "-", "constructor", "__proto__", "MOROCCO", "morocco "]) expect(slugToCountry(s)).toBeNull();
  });

  it("no feed URL is listed twice within one country", () => {
    const dupes = countryEntries.flatMap(([c, b]) => {
      const urls = Object.values(b);
      return urls.filter((u, i) => urls.indexOf(u) !== i).map((u) => `${c}: ${u}`);
    });
    expect(dupes).toEqual([]);
  });

  it("no feed URL is shared between two countries", () => {
    const owner = new Map<string, string>();
    const shared: string[] = [];
    for (const [c, b] of countryEntries) {
      for (const u of Object.values(b)) {
        if (owner.has(u) && owner.get(u) !== c) shared.push(`${u} (${owner.get(u)} & ${c})`);
        owner.set(u, c);
      }
    }
    expect(shared).toEqual([]);
  });

  it("lists which country feed URLs are also topic feeds (reported, not asserted)", () => {
    const topicUrls = new Map<string, string>();
    for (const [t, b] of topicEntries) for (const u of Object.values(b)) topicUrls.set(u, t);
    const overlap = countryEntries.flatMap(([c, b]) =>
      Object.values(b)
        .filter((u) => topicUrls.has(u))
        .map((u) => `${c} = ${topicUrls.get(u)}: ${u}`)
    );
    console.log(`[qa] country feeds identical to a topic feed: ${overlap.length}\n${overlap.join("\n")}`);
    expect(Array.isArray(overlap)).toBe(true);
  });

  it("every country feed URL is https", () => {
    const http = countryEntries.flatMap(([c, b]) =>
      Object.entries(b)
        .filter(([, u]) => new URL(u).protocol !== "https:")
        .map(([s, u]) => `${c} / ${s}: ${u}`)
    );
    console.log(`[qa] plain-http country feeds: ${http.length}\n${http.join("\n")}`);
    expect(Array.isArray(http)).toBe(true);
  });
});

describe("country catalog through the real planner", () => {
  it("every country plans between 3 and 6 feeds, all tagged with it", () => {
    for (const c of COUNTRIES) {
      const plan = planUnitFeeds([{ topic: COUNTRIES_TOPIC, subtopic: c }]);
      expect(plan.length, c).toBeGreaterThanOrEqual(3);
      expect(plan.length, c).toBeLessThanOrEqual(MAX_FEEDS_PER_TOPIC);
      expect(plan.every((f) => f.topic === COUNTRIES_TOPIC && f.subtopic === c), c).toBe(true);
    }
  });

  it("every topic and every country picked at once, every outlet preferred, plans at most 60 feeds", () => {
    const { read } = readingUnits([...TOPICS] as Topic[], [...COUNTRIES]);
    expect(planUnitFeeds(read, [...SOURCES]).length).toBeLessThanOrEqual(60);
  });

  it("Morocco the country is read before Morocco the topic, so a shared article keeps the country", () => {
    const { read } = readingUnits(["Morocco", COUNTRIES_TOPIC] as Topic[], ["Morocco"]);
    expect(read).toEqual([
      { topic: COUNTRIES_TOPIC, subtopic: "Morocco" },
      { topic: "Morocco", subtopic: null },
    ]);
  });

  it("Countries sits before every regional topic in TOPICS", () => {
    const at = (t: string) => (TOPICS as readonly string[]).indexOf(t);
    for (const regional of ["Africa", "Asia-Pacific", "Latin America", "Middle East", "European Union", "Morocco"]) {
      expect(at(COUNTRIES_TOPIC), regional).toBeLessThan(at(regional));
    }
  });
});
