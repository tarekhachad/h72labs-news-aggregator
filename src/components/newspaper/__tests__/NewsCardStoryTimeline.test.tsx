// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card, Topic } from "@/types";
import { NewsCard, storyDayHref, storyDayLabel } from "@/components/newspaper/NewsCard";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";

// The story timeline on a card: the "Day N" chip on the front, the "Earlier
// on this story" list on the back, and each entry's link to its own day.

const TIMELINE: Card["timeline"] = {
  date: "2026-10-13",
  day: 3,
  earlier: [
    { id: "old-1", date: "2026-10-10", title: "Talks open in Doha", topic: "Geopolitics" as Topic },
    { id: "old-2", date: "2026-10-12", title: "", topic: "Countries" as Topic },
  ],
};

function makeCard(extra: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    topic: "Geopolitics" as Topic,
    title: "Ceasefire agreed after Doha talks",
    shortSummary: "A short summary of the story.",
    labels: [],
    expandedReport: "A report.",
    sources: [{ source: "BBC" as Card["sources"][number]["source"], title: "First story", url: "https://a.example/1", snippet: "" }],
    publishedAt: "2026-10-13T08:00:00Z",
    generatedAt: "2026-10-13T09:00:00Z",
    bookmarked: false,
    severity: 3,
    frontPageRank: 1,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(card: Card) {
  await act(async () => {
    root.render(
      <FocusModeProvider>
        <NewsCard card={card} tier="hero" showTopicBadge />
      </FocusModeProvider>
    );
  });
}

const faces = () => [...container.querySelectorAll<HTMLElement>("[inert], [style*='backface']")].filter((el) => el.style.backfaceVisibility === "hidden");
const front = () => faces()[0];
const back = () => faces()[1];
const button = (label: RegExp) => [...container.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""))!;
const earlierLinks = () => [...back().querySelectorAll<HTMLAnchorElement>("a")].filter((a) => a.getAttribute("href")?.startsWith("/history/"));

describe("storyDayLabel", () => {
  it("reads the date string directly, adding the year only when it differs", () => {
    expect(storyDayLabel("2026-10-10", "2026")).toBe("Oct 10");
    expect(storyDayLabel("2026-01-02", "2026")).toBe("Jan 2");
    expect(storyDayLabel("2025-12-30", "2026")).toBe("Dec 30, 2025");
  });
});

describe("storyDayHref", () => {
  it("opens the entry's day on its topic's page, at the card", () => {
    expect(storyDayHref({ id: "old-1", date: "2026-10-10", title: "t", topic: "Geopolitics" as Topic })).toBe("/history/2026-10-10/topic/geopolitics#card-old-1");
    expect(storyDayHref({ id: "x", date: "2026-10-10", title: "t", topic: "Tech/AI" as Topic })).toMatch(/^\/history\/2026-10-10\/topic\/[a-z0-9-]+#card-x$/);
  });

  // The unfiltered Countries page shows only a few cards a day, so a link to a
  // Countries card opens its country's filter, where every card of the
  // country is listed: the URL CountryFilter builds, plus the card anchor.
  it("opens a Countries card's day filtered to its country", () => {
    expect(
      storyDayHref({ id: "us-1", date: "2026-10-01", title: "t", topic: "Countries" as Topic, subtopic: "United States" })
    ).toBe("/history/2026-10-01/topic/countries?country=united-states#card-us-1");
    expect(
      storyDayHref({ id: "ci-1", date: "2026-10-01", title: "t", topic: "Countries" as Topic, subtopic: "Côte d'Ivoire" })
    ).toBe("/history/2026-10-01/topic/countries?country=cote-d-ivoire#card-ci-1");
  });

  it("leaves the Countries page unfiltered when the card has no country, and ignores a subtopic on another topic", () => {
    expect(storyDayHref({ id: "c", date: "2026-10-01", title: "t", topic: "Countries" as Topic, subtopic: null })).toBe(
      "/history/2026-10-01/topic/countries#card-c"
    );
    expect(storyDayHref({ id: "g", date: "2026-10-01", title: "t", topic: "Geopolitics" as Topic, subtopic: "France" })).toBe(
      "/history/2026-10-01/topic/geopolitics#card-g"
    );
  });
});

describe("NewsCard story timeline", () => {
  it("gives the card the id a timeline link lands on", async () => {
    await render(makeCard());
    expect(container.querySelector("#card-card-1")?.getAttribute("role")).toBe("button");
  });

  it("shows a Day N chip on the front, named for screen readers", async () => {
    await render(makeCard({ timeline: TIMELINE }));
    const chip = [...front().querySelectorAll("span")].find((s) => s.textContent?.startsWith("Day "));
    expect(chip?.textContent).toBe("Day 3 of this story");
    expect(chip?.querySelector(".sr-only")?.textContent).toBe(" of this story");
  });

  it("shows no chip and no list on a story's first day", async () => {
    await render(makeCard());
    expect(container.textContent).not.toMatch(/Day \d/);
    expect(container.textContent).not.toMatch(/EARLIER ON THIS STORY/);
  });

  it("lists the earlier days on the back, each link named by its date and title", async () => {
    await render(makeCard({ timeline: TIMELINE }));
    expect(back().textContent).toContain("EARLIER ON THIS STORY");
    const links = earlierLinks();
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Oct 10 Talks open in Doha", "/history/2026-10-10/topic/geopolitics#card-old-1"],
      // A card with no title (older rows) is named by its topic.
      ["Oct 12 Countries", "/history/2026-10-12/topic/countries#card-old-2"],
    ]);
  });

  it("leaves out the year of the card's own day, not of its UTC timestamp", async () => {
    // Generated late on Dec 31 in Atlanta: already Jan 1 in UTC.
    await render(
      makeCard({
        generatedAt: "2026-01-01T03:00:00Z",
        timeline: { date: "2025-12-31", day: 2, earlier: [{ id: "old", date: "2025-12-30", title: "Talks open", topic: "Geopolitics" as Topic }] },
      })
    );
    expect(earlierLinks()[0].textContent).toBe("Dec 30 Talks open");
  });

  it("keeps the list unreachable until the card is flipped, then focuses Back as before", async () => {
    await render(makeCard({ timeline: TIMELINE }));
    expect(back().hasAttribute("inert")).toBe(true);
    await act(async () => button(/^Sources/).click());
    expect(back().hasAttribute("inert")).toBe(false);
    expect(front().hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.textContent).toBe("Back");
  });

  it("a click or Enter on an earlier day doesn't flip the card back or open it", async () => {
    await render(makeCard({ timeline: TIMELINE }));
    await act(async () => button(/^Sources/).click());
    const link = earlierLinks()[0];
    link.addEventListener("click", (e) => e.preventDefault());
    await act(async () => link.click());
    await act(async () => {
      link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(button(/^Sources/).getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });
});
