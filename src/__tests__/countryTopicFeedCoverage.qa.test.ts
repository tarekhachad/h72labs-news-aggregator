import { describe, expect, it } from "vitest";
import { planUnitFeeds, MAX_FEEDS_PER_TOPIC } from "@/lib/ingest";
import { COUNTRIES_TOPIC, COUNTRY_FEEDS } from "@/config/countries";
import { FEEDS } from "@/config/feeds";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { readingUnits } from "@/lib/readingUnits";

// Independent QA of what a reader moved from a single-country topic reads,
// beyond the lane's no-preference case: with preferred outlets, beside the
// reader's other topics, and against the catalog's own numbers.

const MOVED = ["United States", "United Kingdom", "France", "Morocco"];

const countryOnly = (country: string, preferred: Source[] = []) =>
  planUnitFeeds([{ topic: COUNTRIES_TOPIC, subtopic: country }], preferred).map((f) => f.source as string);

describe("a moved reader with preferred outlets", () => {
  it("a preferred outlet the country lists beyond its first six takes a slot (CBS News and ABC News for the United States)", () => {
    expect(countryOnly("United States")).not.toContain("CBS News");
    expect(countryOnly("United States", ["CBS News"])).toContain("CBS News");
    expect(countryOnly("United States", ["ABC News"])).toContain("ABC News");
    expect(countryOnly("United States", ["CBS News", "ABC News"])).toHaveLength(MAX_FEEDS_PER_TOPIC);
  });

  it("a preferred outlet the country doesn't list changes nothing (The Hill, Bloomberg, The Economist, France24)", () => {
    for (const country of MOVED) {
      for (const outlet of ["The Hill", "Bloomberg", "The Economist", "France24", "CNBC"] as Source[]) {
        expect(countryOnly(country, [outlet]), `${country} + ${outlet}`).toEqual(countryOnly(country));
      }
    }
  });

  it("Morocco's preferred Challenge.ma or Yabiladi comes in at the expense of Le Desk", () => {
    expect(countryOnly("Morocco", ["Challenge.ma"])).toContain("Challenge.ma");
    expect(countryOnly("Morocco", ["Yabiladi"])).toContain("Yabiladi");
  });
});

describe("a moved reader's country beside their other topics", () => {
  it("no topic shares a feed with a moved country, so the country keeps all six slots whatever else is picked", () => {
    for (const country of MOVED) {
      const alone = countryOnly(country);
      for (const topic of TOPICS) {
        if (topic === COUNTRIES_TOPIC) continue;
        const { read } = readingUnits([topic, COUNTRIES_TOPIC] as Topic[], [country]);
        const plan = planUnitFeeds(read).filter((f) => f.topic === COUNTRIES_TOPIC).map((f) => f.source as string);
        expect(plan, `${topic} + ${country}`).toEqual(alone);
      }
    }
  });
});

describe("catalog numbers the source catalog states", () => {
  it("58 topics offered; every feed and outlet behind them counted", () => {
    expect(TOPICS.length - 1).toBe(58);
    const grids = Object.values(FEEDS);
    const feedCount = grids.reduce((n, g) => n + Object.keys(g).length, 0);
    const outlets = new Set(grids.flatMap((g) => Object.keys(g)));
    expect(feedCount).toBe(331);
    expect(outlets.size).toBe(138);
  });

  it("no removed outlet is offered or read anywhere", () => {
    for (const gone of ["RFI (FR)", "Fortune", "MarketWatch"]) {
      expect(SOURCES as readonly string[]).not.toContain(gone);
      for (const g of [...Object.values(FEEDS), ...Object.values(COUNTRY_FEEDS)]) expect(Object.keys(g)).not.toContain(gone);
    }
  });
});
