// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card, Topic } from "@/types";

// The Countries page's filter: TopicPage rendered for real, with TopicNav
// (needs the page-transition provider) and NewsCard (Motion, measured
// layout) stubbed down to what this page decides about each card.

vi.mock("@/components/newspaper/TopicNav", () => ({ TopicNav: () => null }));
vi.mock("@/components/newspaper/NewsCard", () => ({
  NewsCard: ({ card, showTopicBadge }: { card: Card; showTopicBadge: boolean }) => (
    <article data-id={card.id} data-badge={String(showTopicBadge)} />
  ),
}));

const { TopicPage, filterCountryCards } = await import("@/components/newspaper/TopicPage");
const { COUNTRIES_TOPIC } = await import("@/config/countries");

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
    title: `Headline ${id}`,
    shortSummary: "Summary.",
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

const CARDS = [
  card("u1", "Uganda", COUNTRIES_TOPIC, 5),
  card("k1", "Kenya"),
  card("u2", "Uganda"),
  card("c1", "Côte d'Ivoire"),
];

async function render(props: { cards?: Card[]; topic?: Topic; country?: string; basePath?: string }) {
  await act(async () =>
    root.render(
      <TopicPage
        cards={props.cards ?? CARDS}
        topic={props.topic ?? COUNTRIES_TOPIC}
        userTopics={[COUNTRIES_TOPIC]}
        country={props.country}
        basePath={props.basePath}
      />
    )
  );
}

const filterNav = () => container.querySelector('nav[aria-label="Filter by country"]');
const links = () =>
  [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Filter by country"] a')].map((a) => ({
    label: a.textContent,
    href: a.getAttribute("href"),
    current: a.getAttribute("aria-current"),
  }));
const shownIds = () => [...container.querySelectorAll("article")].map((a) => a.getAttribute("data-id"));

describe("filterCountryCards", () => {
  it("lists each country among the cards once, sorted, and keeps every card without a slug", () => {
    const { countries, activeSlug, shown } = filterCountryCards(CARDS, undefined);
    expect(countries).toEqual(["Côte d'Ivoire", "Kenya", "Uganda"]);
    expect(activeSlug).toBeNull();
    expect(shown).toBe(CARDS);
  });

  it("keeps only the named country's cards", () => {
    const { activeSlug, shown } = filterCountryCards(CARDS, "uganda");
    expect(activeSlug).toBe("uganda");
    expect(shown.map((c) => c.id)).toEqual(["u1", "u2"]);
  });

  it("matches an accented country by its plain slug", () => {
    expect(filterCountryCards(CARDS, "cote-d-ivoire").shown.map((c) => c.id)).toEqual(["c1"]);
  });

  it("shows every card for a slug that names none of the day's countries", () => {
    for (const slug of ["morocco", "", "UGANDA", "uganda "]) {
      const { activeSlug, shown } = filterCountryCards(CARDS, slug);
      expect(activeSlug).toBeNull();
      expect(shown).toBe(CARDS);
    }
  });

  it("offers nothing when no card has a country", () => {
    expect(filterCountryCards([card("a", null), card("b", null)], undefined).countries).toEqual([]);
  });
});

describe("the Countries page", () => {
  it("shows All plus one link per country among the day's cards, with All marked by default", async () => {
    await render({});
    expect(links()).toEqual([
      { label: "All", href: "/topic/countries", current: "page" },
      { label: "Côte d'Ivoire", href: "/topic/countries?country=cote-d-ivoire", current: null },
      { label: "Kenya", href: "/topic/countries?country=kenya", current: null },
      { label: "Uganda", href: "/topic/countries?country=uganda", current: null },
    ]);
    expect(shownIds().sort()).toEqual(["c1", "k1", "u1", "u2"]);
  });

  it("shows only the chosen country's cards, with its link marked", async () => {
    await render({ country: "uganda" });
    expect(shownIds()).toEqual(["u1", "u2"]);
    expect(links().filter((l) => l.current === "page").map((l) => l.label)).toEqual(["Uganda"]);
    // The other countries stay offered.
    expect(links().map((l) => l.label)).toEqual(["All", "Côte d'Ivoire", "Kenya", "Uganda"]);
  });

  it("shows every card for an unknown country", async () => {
    await render({ country: "atlantis" });
    expect(shownIds().sort()).toEqual(["c1", "k1", "u1", "u2"]);
    expect(links().filter((l) => l.current === "page").map((l) => l.label)).toEqual(["All"]);
  });

  it("keeps a past day's links on that day", async () => {
    await render({ basePath: "/history/2026-09-01", country: "kenya" });
    expect(links().map((l) => l.href)).toEqual([
      "/history/2026-09-01/topic/countries",
      "/history/2026-09-01/topic/countries?country=cote-d-ivoire",
      "/history/2026-09-01/topic/countries?country=kenya",
      "/history/2026-09-01/topic/countries?country=uganda",
    ]);
    expect(shownIds()).toEqual(["k1"]);
  });

  it("shows each Countries card's badge, so the card can show its country", async () => {
    await render({});
    expect([...container.querySelectorAll("article")].every((a) => a.getAttribute("data-badge") === "true")).toBe(
      true
    );
  });

  it("shows no filter when the day has no Countries cards", async () => {
    await render({ cards: [] });
    expect(filterNav()).toBeNull();
    expect(container.textContent).toContain(`No notable ${COUNTRIES_TOPIC} news today.`);
  });
});

describe("every other topic page", () => {
  it("shows no filter, ignores a country param, and keeps its badges hidden", async () => {
    const topic = "Tech/AI" as Topic;
    const cards = [card("t1", null, topic), card("t2", null, topic)];
    await render({ topic, cards, country: "uganda" });
    expect(filterNav()).toBeNull();
    expect(shownIds().sort()).toEqual(["t1", "t2"]);
    expect([...container.querySelectorAll("article")].map((a) => a.getAttribute("data-badge"))).toEqual([
      "false",
      "false",
    ]);
  });
});
