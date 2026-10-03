// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card, Topic } from "@/types";

vi.mock("@/components/newspaper/TopicNav", () => ({ TopicNav: () => null }));
vi.mock("@/components/newspaper/NewsCard", () => ({
  NewsCard: ({ card, showTopicBadge }: { card: Card; showTopicBadge: boolean }) => (
    <article data-id={card.id} data-badge={String(showTopicBadge)} />
  ),
}));

const { TopicPage, filterCountryCards } = await import("@/components/newspaper/TopicPage");
const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { cardTopicLabel } = await import("@/components/cardTopicLabel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function card(id: string, subtopic: string | null, topic: Topic = COUNTRIES_TOPIC, severity = 3): Card {
  return {
    id,
    topic,
    subtopic,
    title: `H ${id}`,
    shortSummary: "S.",
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: false,
    severity,
    frontPageRank: null,
  };
}

const links = () =>
  [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Filter by country"] a')].map((a) => ({
    label: a.textContent,
    href: a.getAttribute("href"),
    current: a.getAttribute("aria-current"),
  }));
const shown = () => [...container.querySelectorAll("article")].map((a) => a.getAttribute("data-id"));

describe("QA: filterCountryCards edges", () => {
  it("empty card list yields no options and no active slug, even for a slug", () => {
    const r = filterCountryCards([], "kenya");
    expect(r).toEqual({ countries: [], activeSlug: null, shown: [] });
  });

  it("many duplicate subtopics collapse to one option; filter keeps all of them", () => {
    const cards = ["a", "b", "c", "d"].map((id) => card(id, "Kenya"));
    const r = filterCountryCards(cards, "kenya");
    expect(r.countries).toEqual(["Kenya"]);
    expect(r.shown.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("two spellings that share a slug become one option and filter together", () => {
    const cards = [card("a", "Côte d'Ivoire"), card("b", "Cote d'Ivoire")];
    const r = filterCountryCards(cards, "cote-d-ivoire");
    expect(r.countries).toHaveLength(1);
    expect(r.shown.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("cards with no subtopic stay out of the options and out of a filtered view", () => {
    const cards = [card("a", null), card("b", "Kenya"), card("c", "")];
    const r = filterCountryCards(cards, "kenya");
    expect(r.countries).toEqual(["Kenya"]);
    expect(r.shown.map((c) => c.id)).toEqual(["b"]);
  });

  it("an all-symbols subtopic gets an empty slug: never matches a real slug, no crash", () => {
    const cards = [card("a", "***"), card("b", "Kenya")];
    const r = filterCountryCards(cards, "kenya");
    expect(r.shown.map((c) => c.id)).toEqual(["b"]);
    expect(() => filterCountryCards(cards, "")).not.toThrow();
  });

  it("prototype-ish slugs do not match", () => {
    for (const slug of ["__proto__", "constructor", "toString"]) {
      const r = filterCountryCards([card("a", "Kenya")], slug);
      expect(r.activeSlug).toBeNull();
      expect(r.shown).toHaveLength(1);
    }
  });
});

describe("QA: Countries page rendering", () => {
  it("filtering does not change the card order inside the filtered set (severity order kept)", async () => {
    const cards = [card("lo", "Kenya", COUNTRIES_TOPIC, 1), card("x", "Mali"), card("hi", "Kenya", COUNTRIES_TOPIC, 5)];
    await act(async () =>
      root.render(<TopicPage cards={cards} topic={COUNTRIES_TOPIC} userTopics={[COUNTRIES_TOPIC]} country="kenya" />)
    );
    expect(shown()).toEqual(["hi", "lo"]);
  });

  it("duplicate subtopics produce one link each, and a slug with a duplicate marks exactly one link current", async () => {
    const cards = [card("a", "Kenya"), card("b", "Kenya"), card("c", "Mali")];
    await act(async () =>
      root.render(<TopicPage cards={cards} topic={COUNTRIES_TOPIC} userTopics={[COUNTRIES_TOPIC]} country="kenya" />)
    );
    expect(links().map((l) => l.label)).toEqual(["All", "Kenya", "Mali"]);
    expect(links().filter((l) => l.current)).toHaveLength(1);
    expect(shown()).toEqual(expect.arrayContaining(["a", "b"]));
    expect(shown()).toHaveLength(2);
  });

  it("no filter nav when Countries cards exist but none has a subtopic; badge off for them", async () => {
    await act(async () =>
      root.render(
        <TopicPage cards={[card("a", null)]} topic={COUNTRIES_TOPIC} userTopics={[COUNTRIES_TOPIC]} />
      )
    );
    expect(container.querySelector("nav[aria-label='Filter by country']")).toBeNull();
    expect(container.querySelector("article")!.getAttribute("data-badge")).toBe("false");
  });

  it("a non-Countries page whose cards carry a subtopic still shows badge only per subtopic and no filter", async () => {
    const t = "Tech/AI" as Topic;
    await act(async () =>
      root.render(
        <TopicPage cards={[card("a", "Kenya", t), card("b", null, t)]} topic={t} userTopics={[t]} country="kenya" />
      )
    );
    expect(container.querySelector("nav[aria-label='Filter by country']")).toBeNull();
    expect(shown().sort()).toEqual(["a", "b"]);
  });

  it("a hostile country param is encoded safely in links only from card data, not echoed", async () => {
    await act(async () =>
      root.render(
        <TopicPage
          cards={[card("a", "Kenya")]}
          topic={COUNTRIES_TOPIC}
          userTopics={[COUNTRIES_TOPIC]}
          country={'"><script>alert(1)</script>'}
        />
      )
    );
    expect(container.innerHTML).not.toContain("<script>");
    expect(shown()).toEqual(["a"]);
  });

  it("filter option whose name has odd characters encodes in href", async () => {
    await act(async () =>
      root.render(
        <TopicPage cards={[card("a", "São Tomé & Príncipe")]} topic={COUNTRIES_TOPIC} userTopics={[COUNTRIES_TOPIC]} />
      )
    );
    expect(links()[1].href).toBe("/topic/countries?country=sao-tome-principe");
  });
});

describe("QA: cardTopicLabel", () => {
  it("only Countries-style subtopics add a suffix; whitespace-only subtopic is shown as is", () => {
    expect(cardTopicLabel({ topic: "Tech/AI" as Topic, subtopic: null })).toBe("Tech/AI");
    expect(cardTopicLabel({ topic: COUNTRIES_TOPIC, subtopic: "Kenya" })).toBe(`${COUNTRIES_TOPIC} · Kenya`);
    expect(cardTopicLabel({ topic: COUNTRIES_TOPIC, subtopic: "" })).toBe(COUNTRIES_TOPIC);
  });
});
