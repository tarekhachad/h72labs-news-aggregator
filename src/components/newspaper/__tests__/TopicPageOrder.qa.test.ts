import { describe, it, expect } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { SOURCES, TOPICS, type Card, type Source } from "@/types";
import { TopicPage, orderBySeverity } from "@/components/newspaper/TopicPage";
import { NewsCard } from "@/components/newspaper/NewsCard";

// QA edges for the topic-page order: zero preferences must reproduce the
// old comparator exactly, the order must be a total order with preferences,
// and TopicPage must actually hand its preferredSources to the sort.

function card(id: string, severity: number, publishedAt: string, outlets: Source[]): Card {
  return {
    id,
    topic: TOPICS[0],
    title: id,
    shortSummary: "",
    labels: [],
    expandedReport: null,
    sources: outlets.map((source, i) => ({
      title: `${id}-${i}`,
      url: `https://example.test/${id}/${i}`,
      source,
      snippet: "",
    })),
    publishedAt,
    generatedAt: "2026-10-02T06:00:00Z",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

const ids = (cards: Card[]) => cards.map((c) => c.id);

// The comparator before this change, copied verbatim as the oracle.
function oldOrder(cards: Card[]): Card[] {
  return [...cards].sort(
    (a, b) =>
      b.severity - a.severity ||
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// Small deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomCards(rand: () => number, n: number): Card[] {
  return Array.from({ length: n }, (_, i) => {
    const outlets = Array.from({ length: Math.floor(rand() * 4) }, () => SOURCES[Math.floor(rand() * 6)]);
    // Few distinct severities and timestamps, so ties are common.
    const hour = 6 + Math.floor(rand() * 3);
    return card(`c${String(Math.floor(rand() * 1000)).padStart(3, "0")}-${i}`, 1 + Math.floor(rand() * 3), `2026-10-02T0${hour}:00:00Z`, outlets);
  });
}

describe("orderBySeverity edges", () => {
  it("with zero preferences matches the old comparator on 200 random inputs", () => {
    const rand = rng(42);
    for (let trial = 0; trial < 200; trial++) {
      const cards = randomCards(rand, 2 + Math.floor(rand() * 12));
      expect(ids(orderBySeverity(cards, []))).toEqual(ids(oldOrder(cards)));
      expect(ids(orderBySeverity(cards))).toEqual(ids(oldOrder(cards)));
    }
  });

  it("with preferences no card carries, matches the old comparator", () => {
    const rand = rng(7);
    const unused = SOURCES.slice(6, 9);
    expect(unused.length).toBeGreaterThan(0);
    for (let trial = 0; trial < 100; trial++) {
      const cards = randomCards(rand, 2 + Math.floor(rand() * 12));
      expect(ids(orderBySeverity(cards, unused))).toEqual(ids(oldOrder(cards)));
    }
  });

  it("is a total order with preferences: every input permutation sorts the same", () => {
    const rand = rng(99);
    const prefs = SOURCES.slice(0, 2);
    for (let trial = 0; trial < 100; trial++) {
      const cards = randomCards(rand, 6);
      const expected = ids(orderBySeverity(cards, prefs));
      const shuffled = [...cards].sort(() => rand() - 0.5);
      expect(ids(orderBySeverity(shuffled, prefs))).toEqual(expected);
      expect(ids(orderBySeverity([...cards].reverse(), prefs))).toEqual(expected);
    }
  });

  it("with preferences, only reorders within a severity and is never worse on the preferred count", () => {
    const rand = rng(5);
    const prefs = SOURCES.slice(0, 2);
    const count = (c: Card) => new Set(c.sources.map((s) => s.source).filter((s) => prefs.includes(s as Source))).size;
    for (let trial = 0; trial < 100; trial++) {
      const out = orderBySeverity(randomCards(rand, 10), prefs);
      for (let i = 1; i < out.length; i++) {
        expect(out[i - 1].severity).toBeGreaterThanOrEqual(out[i].severity);
        if (out[i - 1].severity === out[i].severity) {
          expect(count(out[i - 1])).toBeGreaterThanOrEqual(count(out[i]));
        }
      }
    }
  });

  it("non-preferred outlets don't count, however many", () => {
    const [A, , , D, E, F] = SOURCES;
    const many = card("many", 3, "2026-10-02T09:00:00Z", [D, E, F]);
    const one = card("one", 3, "2026-10-02T07:00:00Z", [A]);
    expect(ids(orderBySeverity([many, one], [A]))).toEqual(["one", "many"]);
  });

  it("a card with no sources sorts as zero preferred, not as an error", () => {
    const empty = card("empty", 3, "2026-10-02T09:00:00Z", []);
    const pref = card("pref", 3, "2026-10-02T07:00:00Z", [SOURCES[0]]);
    expect(ids(orderBySeverity([empty, pref], [SOURCES[0]]))).toEqual(["pref", "empty"]);
  });

  it("a story with one preferred source beats one with none (Tarek's rule 1)", () => {
    const [A, B] = SOURCES;
    const none = card("none", 2, "2026-10-02T09:00:00Z", [B]);
    const has = card("has", 2, "2026-10-02T06:00:00Z", [A]);
    expect(ids(orderBySeverity([none, has], [A]))).toEqual(["has", "none"]);
  });
});

function findAll(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, out);
    return out;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) out.push(el);
  findAll(el.props?.children, type, out);
  return out;
}

describe("TopicPage wiring", () => {
  it("renders cards in preferred-source order when preferredSources is passed", () => {
    const [A, B] = SOURCES;
    const newer = card("newer", 3, "2026-10-02T09:00:00Z", [B]);
    const older = card("older", 3, "2026-10-02T07:00:00Z", [A]);
    const render = (preferredSources?: Source[]) =>
      findAll(
        TopicPage({ cards: [newer, older], topic: TOPICS[0], userTopics: [TOPICS[0]], preferredSources }),
        NewsCard
      ).map((el) => (el.props as { card: Card }).card.id);

    expect(render([A])).toEqual(["older", "newer"]);
    expect(render([])).toEqual(["newer", "older"]);
    expect(render(undefined)).toEqual(["newer", "older"]);
  });
});
