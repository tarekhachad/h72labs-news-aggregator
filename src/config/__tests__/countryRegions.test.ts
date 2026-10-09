import { describe, it, expect } from "vitest";
import { COUNTRIES } from "@/config/countries";
import { COUNTRY_REGIONS, countriesByRegion } from "@/config/countryRegions";

describe("country regions", () => {
  it("puts every offered country in exactly one region, and nothing else", () => {
    const grouped = COUNTRY_REGIONS.flatMap((region) => region.countries);
    expect([...grouped].sort()).toEqual([...COUNTRIES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("has the five regions, in the picker's order", () => {
    expect(COUNTRY_REGIONS.map((region) => region.name)).toEqual([
      "Africa",
      "Americas",
      "Asia-Pacific",
      "Europe",
      "Middle East",
    ]);
  });

  it("gives the picker each region's countries in COUNTRIES order", () => {
    const groups = countriesByRegion();
    expect(groups.map((group) => group.label)).toEqual(COUNTRY_REGIONS.map((region) => region.name));
    for (const group of groups) {
      const positions = group.items.map((country) => COUNTRIES.indexOf(country));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
    expect(groups.flatMap((group) => group.items)).toHaveLength(COUNTRIES.length);
  });

  it("places a few countries where a reader would look for them", () => {
    const regionOf = (country: string) => COUNTRY_REGIONS.find((r) => r.countries.includes(country))?.name;
    expect(regionOf("Morocco")).toBe("Africa");
    expect(regionOf("Mexico")).toBe("Americas");
    expect(regionOf("Japan")).toBe("Asia-Pacific");
    expect(regionOf("United Kingdom")).toBe("Europe");
    expect(regionOf("Lebanon")).toBe("Middle East");
  });
});
