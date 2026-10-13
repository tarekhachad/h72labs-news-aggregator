import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import * as names from "@/config/countryNames";
import * as feeds from "@/config/countries";

// QA round 1: the country names moved out of the feed table's module. Server
// code that still takes them from countries.ts must get the very same values,
// the feed table must still cover exactly the offered countries, and the
// names module must stay free of URLs and imports so the browser can load it.

describe("countryNames / countries split", () => {
  it("countries.ts re-exports the names module's own bindings, not copies", () => {
    expect(feeds.COUNTRIES).toBe(names.COUNTRIES);
    expect(feeds.COUNTRIES_TOPIC).toBe(names.COUNTRIES_TOPIC);
    expect(feeds.countryToSlug).toBe(names.countryToSlug);
    expect(feeds.slugToCountry).toBe(names.slugToCountry);
  });

  it("the feed table has exactly one entry per offered country, in the same order", () => {
    expect(Object.keys(feeds.COUNTRY_FEEDS)).toEqual([...names.COUNTRIES]);
  });

  it("every offered country round-trips through its slug, and slugs are unique", () => {
    const slugs = names.COUNTRIES.map(names.countryToSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const country of names.COUNTRIES) {
      expect(names.slugToCountry(names.countryToSlug(country))).toBe(country);
    }
    expect(names.slugToCountry("")).toBeNull();
    expect(names.slugToCountry("atlantis")).toBeNull();
  });

  it("the names module carries no URL and imports nothing", () => {
    const code = readFileSync(resolve(__dirname, "../countryNames.ts"), "utf8");
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\bfrom\s+["']/);
  });

  it("countries.ts no longer defines the names itself", () => {
    const code = readFileSync(resolve(__dirname, "../countries.ts"), "utf8");
    expect(code).not.toMatch(/export\s+const\s+COUNTRIES\b/);
    expect(code).not.toMatch(/export\s+function\s+(countryToSlug|slugToCountry)\b/);
  });
});
