// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card, Source, Topic } from "@/types";

// The Countries page's filter: TopicPage rendered for real, with TopicNav
// (needs the page-transition provider) and NewsCard (Motion, measured
// layout) stubbed down to what this page decides about each card.

vi.mock("@/components/newspaper/TopicNav", () => ({ TopicNav: () => null }));
vi.mock("@/components/newspaper/NewsCard", () => ({
  NewsCard: ({ card, showTopicBadge }: { card: Card; showTopicBadge: boolean }) => (
    <article data-id={card.id} data-badge={String(showTopicBadge)} />
  ),
}));

const { TopicPage, filterCountryCards, COUNTRIES_ALL_LIMIT } = await import("@/components/newspaper/TopicPage");
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

async function render(props: {
  cards?: Card[];
  topic?: Topic;
  country?: string;
  basePath?: string;
  preferredSources?: Source[];
}) {
  await act(async () =>
    root.render(
      <TopicPage
        cards={props.cards ?? CARDS}
        topic={props.topic ?? COUNTRIES_TOPIC}
        userTopics={[COUNTRIES_TOPIC]}
        country={props.country}
        basePath={props.basePath}
        preferredSources={props.preferredSources}
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

describe("the All view's eight cards", () => {
  const ids = (cards: Card[]) => cards.map((c) => c.id);
  // n cards for one country, severities counting down from `top`.
  const many = (country: string, n: number, top = 5) =>
    Array.from({ length: n }, (_, i) => card(`${country.slice(0, 2)}${i}`, country, COUNTRIES_TOPIC, Math.max(1, top - i)));

  it("is the limit the page uses", () => {
    expect(COUNTRIES_ALL_LIMIT).toBe(8);
  });

  it("shows every card when there are eight or fewer", () => {
    const eight = many("Uganda", 8);
    expect(filterCountryCards(eight, undefined).shown).toBe(eight);
    expect(filterCountryCards(CARDS, undefined).shown).toBe(CARDS);
  });

  it("gives a country with one weak card a slot next to a country with many strong ones", () => {
    const kenya = card("ke", "Kenya", COUNTRIES_TOPIC, 1);
    const cards = [...many("Uganda", 10), kenya];
    const { shown, countries } = filterCountryCards(cards, undefined);
    expect(shown).toHaveLength(8);
    expect(ids(shown)).toContain("ke");
    // Uganda fills the other seven with its most important cards.
    expect(ids(shown).filter((id) => id !== "ke")).toEqual(["Ug0", "Ug1", "Ug2", "Ug3", "Ug4", "Ug5", "Ug6"]);
    expect(countries).toEqual(["Kenya", "Uganda"]);
  });

  it("with more countries than slots, keeps the countries whose best card ranks highest", () => {
    const names = ["Angola", "Benin", "Chad", "Egypt", "Fiji", "Ghana", "Haiti", "India", "Japan", "Kenya"];
    // Japan's and Kenya's best cards are the strongest, Angola's and Benin's the weakest; Kenya has a second strong card.
    const cards = [
      ...names.map((name, i) => card(name.toLowerCase(), name, COUNTRIES_TOPIC, 1 + Math.floor(i / 2))),
      card("kenya-2", "Kenya", COUNTRIES_TOPIC, 5),
    ];
    const { shown, countries } = filterCountryCards(cards, undefined);
    // One card per country while slots last: the second Kenya card waits behind every country's first.
    expect(ids(shown).sort()).toEqual(["chad", "egypt", "fiji", "ghana", "haiti", "india", "japan", "kenya"]);
    // Every country stays in the filter, shown or not.
    expect(countries).toEqual(names);
  });

  it("fills the slots left after one card per country with the most important cards overall", () => {
    const cards = [
      ...many("Uganda", 4, 5), // 5, 4, 3, 2
      ...many("Kenya", 4, 4), // 4, 3, 2, 1
      card("ch", "Chad", COUNTRIES_TOPIC, 1),
    ];
    const { shown } = filterCountryCards(cards, undefined);
    // Chad's one card, each country's best, then 5 more by importance: Ug1 (4), Ug2 + Ke1 (3), Ug3 + Ke2 (2).
    expect(ids(shown).sort()).toEqual(["Ke0", "Ke1", "Ke2", "Ug0", "Ug1", "Ug2", "Ug3", "ch"].sort());
  });

  it("breaks ties the way the page orders cards: newer first, then id", () => {
    const names = ["Angola", "Benin", "Chad", "Egypt", "Fiji", "Ghana", "Haiti", "India", "Japan"];
    const cards = names.map((name) => card(name.toLowerCase(), name));
    cards[8] = { ...cards[8], publishedAt: "2026-10-01T13:00:00Z" }; // Japan is the newest.
    const { shown } = filterCountryCards(cards, undefined);
    expect(ids(shown)).toEqual(["angola", "benin", "chad", "egypt", "fiji", "ghana", "haiti", "japan"]);
  });

  it("counts the reader's preferred sources when choosing between equal cards", () => {
    const names = ["Angola", "Benin", "Chad", "Egypt", "Fiji", "Ghana", "Haiti", "India", "Japan"];
    const cards = names.map((name) => card(name.toLowerCase(), name));
    cards[8] = { ...cards[8], sources: [{ title: "t", url: "https://example.com/j", source: "BBC", snippet: "" }] };
    expect(ids(filterCountryCards(cards, undefined).shown)).not.toContain("japan");
    expect(ids(filterCountryCards(cards, undefined, ["BBC"]).shown)).toContain("japan");
    expect(ids(filterCountryCards(cards, undefined, ["BBC"]).shown)).not.toContain("india");
  });

  it("leaves a cardless country out of the balanced pass but lets its cards fill a slot", () => {
    const cards = [...many("Uganda", 8, 3), card("none", null, COUNTRIES_TOPIC, 5)];
    expect(ids(filterCountryCards(cards, undefined).shown)).toContain("none");
  });

  it("still shows every card of a filtered country", () => {
    const cards = [...many("Uganda", 12), card("ke", "Kenya")];
    const { shown, activeSlug } = filterCountryCards(cards, "uganda");
    expect(activeSlug).toBe("uganda");
    expect(shown).toHaveLength(12);
  });

  it("treats an unknown slug as the All view", () => {
    const cards = [...many("Uganda", 12), card("ke", "Kenya")];
    const { shown, activeSlug } = filterCountryCards(cards, "atlantis");
    expect(activeSlug).toBeNull();
    expect(shown).toHaveLength(8);
  });

  it("renders the eight in the page's importance order, with every country still offered", async () => {
    const cards = [card("ke", "Kenya", COUNTRIES_TOPIC, 1), ...many("Uganda", 10)];
    await render({ cards });
    expect(shownIds()).toEqual(["Ug0", "Ug1", "Ug2", "Ug3", "Ug4", "Ug5", "Ug6", "ke"]);
    expect(links().map((l) => l.label)).toEqual(["All", "Kenya", "Uganda"]);
  });

  it("chooses the page's eight with the reader's preferred sources", async () => {
    const names = ["Angola", "Benin", "Chad", "Egypt", "Fiji", "Ghana", "Haiti", "India", "Japan"];
    const cards = names.map((name) => card(name.toLowerCase(), name));
    cards[8] = { ...cards[8], sources: [{ title: "t", url: "https://example.com/j", source: "BBC", snippet: "" }] };
    await render({ cards, preferredSources: ["BBC"] as Source[] });
    expect(shownIds()).toContain("japan");
    expect(shownIds()).not.toContain("india");
  });

  it("renders all of a filtered country's cards, past eight", async () => {
    await render({ cards: [...many("Uganda", 10), card("ke", "Kenya")], country: "uganda" });
    expect(shownIds()).toHaveLength(10);
  });

  it("caps a past day's All view too", async () => {
    await render({ cards: [...many("Uganda", 10), card("ke", "Kenya")], basePath: "/history/2026-09-01" });
    expect(shownIds()).toHaveLength(8);
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
