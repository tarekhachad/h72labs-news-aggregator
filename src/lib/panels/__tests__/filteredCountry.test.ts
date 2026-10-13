import { describe, expect, it, vi } from "vitest";
import type { Card, Topic } from "@/types";
import { TOPICS } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countryNames";
import { filteredCountry } from "../filteredCountry";

// TopicPage pulls in NewsCard and Motion; only its pure filter is used here.
vi.mock("@/components/newspaper/TopicNav", () => ({ TopicNav: () => null }));
vi.mock("@/components/newspaper/NewsCard", () => ({ NewsCard: () => null }));
const { filterCountryCards } = await import("@/components/newspaper/TopicPage");

function card(id: string, subtopic: string | null, topic: Topic = COUNTRIES_TOPIC): Card {
  return {
    id,
    topic,
    subtopic,
    title: id,
    shortSummary: "",
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: false,
    severity: 3,
    frontPageRank: null,
  };
}

const CARDS = [card("k", "Kenya"), card("c", "Côte d'Ivoire"), card("x", null), card("g", "Gone Country")];

describe("filteredCountry", () => {
  it("names the filtered country from COUNTRIES", () => {
    expect(filteredCountry(COUNTRIES_TOPIC, CARDS, "cote-d-ivoire")).toBe("Côte d'Ivoire");
    expect(filteredCountry(COUNTRIES_TOPIC, CARDS, "kenya")).toBe("Kenya");
  });

  it("is null on the unfiltered page, for a country with no card today, and on other topics", () => {
    expect(filteredCountry(COUNTRIES_TOPIC, CARDS, undefined)).toBeNull();
    expect(filteredCountry(COUNTRIES_TOPIC, CARDS, "morocco")).toBeNull();
    expect(filteredCountry(COUNTRIES_TOPIC, [], "kenya")).toBeNull();
    const other = TOPICS.find((t) => t !== COUNTRIES_TOPIC)!;
    expect(filteredCountry(other, [card("k", "Kenya", other)], "kenya")).toBeNull();
  });

  it("is null for a card's country that is no longer offered", () => {
    expect(filteredCountry(COUNTRIES_TOPIC, CARDS, "gone-country")).toBeNull();
  });

  it.each(["kenya", "cote-d-ivoire", "morocco", "", "KENYA", "kenya ", "gone-country", "<b>x</b>"])(
    "agrees with the Countries filter on %j",
    (slug) => {
      const shown = filteredCountry(COUNTRIES_TOPIC, CARDS, slug) !== null;
      const filtered = filterCountryCards(CARDS, slug).activeSlug !== null;
      // A filtered card whose country left COUNTRIES gets the filter but no box.
      expect(shown).toBe(filtered && slug !== "gone-country");
    }
  );
});
