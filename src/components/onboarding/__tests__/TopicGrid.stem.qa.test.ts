import { describe, expect, it } from "vitest";
import { termMatches } from "@/components/onboarding/TopicGrid";

// The stem boundaries of the search rule, one letter either side of each.
describe("termMatches stem boundaries", () => {
  it("a 5-letter term has no stem", () => {
    expect(termMatches("spaces", "space")).toBe(true); // prefix
    expect(termMatches("spar", "space")).toBe(false);
    expect(termMatches("spare", "space")).toBe(false);
  });

  it("a 6-letter term stems to exactly 5 letters (not 4)", () => {
    expect(termMatches("frank", "france")).toBe(false); // 4-letter stem would match
    expect(termMatches("franc", "france")).toBe(true); // 5-letter stem matches
    expect(termMatches("francs", "france")).toBe(true);
  });

  it("a 7-letter term drops at most two letters: stem 5", () => {
    expect(termMatches("moroc", "morocco")).toBe(true);
    expect(termMatches("moro", "morocco")).toBe(false);
    expect(termMatches("moroccan", "morocco")).toBe(true);
  });

  it("an 8-letter term drops at most two letters: stem 6, never 5", () => {
    expect(termMatches("politic", "politics")).toBe(true);
    expect(termMatches("polit", "politics")).toBe(false); // a 3-letter drop
    expect(termMatches("politician", "politics")).toBe(true);
    expect(termMatches("polite", "politics")).toBe(false);
  });

  it("the stem only matches at a word's start", () => {
    expect(termMatches("unmoroccan", "morocco")).toBe(false);
  });
});
