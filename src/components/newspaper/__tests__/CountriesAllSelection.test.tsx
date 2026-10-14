// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Card, Source } from "@/types";

vi.mock("@/components/newspaper/TopicNav", () => ({ TopicNav: () => null }));
vi.mock("@/components/newspaper/NewsCard", () => ({ NewsCard: () => null }));

const { filterCountryCards, orderBySeverity, COUNTRIES_ALL_LIMIT } = await import("@/components/newspaper/TopicPage");
const { COUNTRIES_TOPIC } = await import("@/config/countries");

function card(
  id: string,
  subtopic: string | null,
  severity = 3,
  opts: { sources?: string[]; publishedAt?: string } = {}
): Card {
  return {
    id,
    topic: COUNTRIES_TOPIC,
    subtopic,
    title: id,
    shortSummary: "s",
    labels: [],
    expandedReport: null,
    sources: (opts.sources ?? []).map((s) => ({ source: s, title: "t", url: "http://x/" + s })) as unknown as Card["sources"],
    publishedAt: opts.publishedAt ?? "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}
const ids = (cs: Card[]) => cs.map((c) => c.id);

describe("Countries All selection (adversarial)", () => {
  it("exactly 8 returns the same array; 9 trims to 8", () => {
    const eight = Array.from({ length: 8 }, (_, i) => card(`a${i}`, "Uganda"));
    expect(filterCountryCards(eight, undefined).shown).toBe(eight);
    const nine = [...eight, card("a8", "Uganda", 1)];
    const r = filterCountryCards(nine, undefined);
    expect(r.shown).toHaveLength(8);
    expect(ids(r.shown)).not.toContain("a8");
  });

  it("9 cards, 9 countries: the weakest best-card loses its slot", () => {
    const names = ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "I1"];
    const cards = names.map((n, i) => card(n, n, 5 - Math.floor(i / 3))); // sev 5,5,5,4,4,4,3,3,3
    const r = filterCountryCards(cards, undefined);
    expect(r.shown).toHaveLength(8);
    expect(r.countries).toHaveLength(9);
    expect(ids(r.shown)).not.toContain("I1"); // last by id among the sev-3 tie
  });

  it("duplicate names that slug the same count as one country", () => {
    const cards = [
      card("x1", "Côte d'Ivoire", 5),
      card("x2", "Cote d'Ivoire", 5),
      card("x3", "COTE D IVOIRE", 5),
      ...Array.from({ length: 9 }, (_, i) => card(`k${i}`, "Kenya", 2)),
      card("m1", "Mali", 1),
    ];
    const r = filterCountryCards(cards, undefined);
    expect(ids(r.shown)).toContain("m1");
    expect(ids(r.shown)).toContain("k0");
    expect(ids(r.shown)).toContain("x1");
    expect(r.shown).toHaveLength(8);
    expect(r.countries.filter((c) => /ivoire/i.test(c))).toHaveLength(1);
  });

  it("differently spelled names of one country share a single guaranteed slot", () => {
    const cards = [
      card("x1", "Côte d'Ivoire", 2),
      card("x2", "Cote d'Ivoire", 2),
      card("x3", "COTE D IVOIRE", 2),
      ...Array.from({ length: 7 }, (_, i) => card(`c${i}`, `Country${i}`, 1)),
    ];
    // 10 cards, 8 countries' worth of slots: one Ivoire slot plus 7 others,
    // so the other two Ivoire spellings are cut even though they outrank the rest.
    const r = filterCountryCards(cards, undefined);
    expect(r.shown).toHaveLength(8);
    expect(ids(r.shown).filter((id) => id.startsWith("x"))).toEqual(["x1"]);
  });

  it("null-subtopic cards never take a country slot but fill leftovers", () => {
    const cards = [
      ...Array.from({ length: 6 }, (_, i) => card(`n${i}`, null, 5)),
      card("u", "Uganda", 1),
      card("k", "Kenya", 1),
      card("z", "Chad", 1),
    ];
    const r = filterCountryCards(cards, undefined);
    expect(r.shown).toHaveLength(8);
    expect(ids(r.shown)).toEqual(expect.arrayContaining(["u", "k", "z"]));
    expect(r.countries).toEqual(["Chad", "Kenya", "Uganda"]);
  });

  it("all-null subtopics: still 8 by importance, no countries", () => {
    const cards = Array.from({ length: 12 }, (_, i) => card(`n${i}`, null, (i % 5) + 1));
    const r = filterCountryCards(cards, undefined);
    expect(r.shown).toHaveLength(8);
    expect(r.countries).toEqual([]);
    expect(r.activeSlug).toBeNull();
    expect(Math.min(...r.shown.map((c) => c.severity))).toBeGreaterThanOrEqual(2);
  });

  it("empty input", () => {
    expect(filterCountryCards([], undefined)).toEqual({ countries: [], activeSlug: null, shown: [] });
  });

  it("a preferred source decides which of two equal-severity cards is the country's best", () => {
    const pref = ["BBC"] as unknown as Source[];
    const tight = [
      card("u-plain", "Uganda", 4),
      card("u-pref", "Uganda", 4, { sources: ["BBC"] }),
      ...Array.from({ length: 7 }, (_, i) => card(`c${i}`, `Country${i}`, 4)),
    ];
    // 9 cards, 8 countries: Uganda holds one slot, the other Uganda card is cut.
    // With BBC preferred, u-pref outranks everything at sev 4, so it is the
    // one that keeps the slot; the cut is a plain card.
    const t = filterCountryCards(tight, undefined, pref).shown;
    expect(t).toHaveLength(8);
    expect(ids(t)).toContain("u-pref");
    expect(ids(t)).not.toContain("u-plain");
  });

  it("more than 8 countries: winners are exactly the 8 highest best-cards, one each", () => {
    const names = Array.from({ length: 12 }, (_, i) => `Land${String.fromCharCode(65 + i)}`);
    const cards = names.flatMap((n, i) => [card(`${n}-1`, n, (i % 5) + 1), card(`${n}-2`, n, 1)]);
    const r = filterCountryCards(cards, undefined);
    expect(r.shown).toHaveLength(8);
    expect(new Set(r.shown.map((c) => c.subtopic)).size).toBe(8);
    expect(r.countries).toHaveLength(12);
    const bests = orderBySeverity(cards.filter((c) => c.id.endsWith("-1")));
    expect(ids(r.shown).sort()).toEqual(ids(bests.slice(0, 8)).sort());
  });

  it("deterministic: input order does not change the chosen set", () => {
    const cards = Array.from({ length: 30 }, (_, i) =>
      card(`id${i}`, `C${i % 7}`, ((i * 7) % 5) + 1, { publishedAt: `2026-10-01T${String(i % 24).padStart(2, "0")}:00:00Z` })
    );
    const a = ids(filterCountryCards(cards, undefined).shown).sort();
    const b = ids(filterCountryCards([...cards].reverse(), undefined).shown).sort();
    expect(b).toEqual(a);
    expect(ids(filterCountryCards(cards, undefined).shown).sort()).toEqual(a);
  });

  it("shown preserves input order and does not mutate the input", () => {
    const cards = Array.from({ length: 12 }, (_, i) => card(`id${i}`, `C${i}`, (i % 5) + 1));
    const snapshot = ids(cards);
    const r = filterCountryCards(cards, undefined);
    expect(ids(cards)).toEqual(snapshot);
    const positions = r.shown.map((c) => snapshot.indexOf(c.id));
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });

  it("a filtered country is unlimited; an unknown slug acts as All", () => {
    const cards = Array.from({ length: 15 }, (_, i) => card(`u${i}`, "Uganda")).concat([card("k", "Kenya")]);
    const f = filterCountryCards(cards, "uganda");
    expect(f.shown).toHaveLength(15);
    expect(f.activeSlug).toBe("uganda");
    const unk = filterCountryCards(cards, "atlantis");
    expect(unk.activeSlug).toBeNull();
    expect(unk.shown).toHaveLength(COUNTRIES_ALL_LIMIT);
    expect(ids(unk.shown)).toContain("k");
  });
});
