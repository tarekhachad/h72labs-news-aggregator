import { describe, expect, it } from "vitest";
import { hasFlag } from "country-flag-icons";
import { COUNTRIES } from "@/config/countries";
import { COUNTRY_CODES, countryCode } from "@/config/countryCodes";

// Every country a reader can pick has exactly one ISO 3166-1 alpha-2 code,
// with a flag to show for it.

const regionName = new Intl.DisplayNames(["en"], { type: "region" });

describe("COUNTRY_CODES", () => {
  it("covers exactly the countries in COUNTRIES", () => {
    expect(Object.keys(COUNTRY_CODES).sort()).toEqual([...COUNTRIES].sort());
  });

  it.each([...COUNTRIES])("%s has one valid code with a flag", (country) => {
    const code = countryCode(country);
    expect(code).toMatch(/^[A-Z]{2}$/);
    expect(hasFlag(code!)).toBe(true);
    // An unknown region code comes back unchanged.
    expect(regionName.of(code!)).not.toBe(code);
  });

  it("gives no two countries the same code", () => {
    const codes = Object.values(COUNTRY_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it.each([
    ["DR Congo", "CD"],
    ["Côte d'Ivoire", "CI"],
    ["Czech Republic", "CZ"],
    ["The Gambia", "GM"],
    ["North Korea", "KP"],
    ["South Korea", "KR"],
    ["Palestine", "PS"],
    ["Hong Kong", "HK"],
    ["Puerto Rico", "PR"],
    ["United Kingdom", "GB"],
    ["Myanmar", "MM"],
    ["Morocco", "MA"],
  ])("maps the non-obvious name %s to %s", (country, code) => {
    expect(countryCode(country)).toBe(code);
  });

  it("has no code for a name outside the list, including inherited keys", () => {
    expect(countryCode("Atlantis")).toBeNull();
    expect(countryCode("toString")).toBeNull();
    expect(countryCode("morocco")).toBeNull();
  });
});
