import { describe, expect, it, vi } from "vitest";
import { use } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import type { Card, Topic } from "@/types";

// The topic page's panel band: a slot between the heading (and the Countries
// filter) and the cards, inside its own Suspense boundary. TopicNav and
// NewsCard are stubbed down to markers, as in CountriesPage.test.tsx.

vi.mock("@/components/newspaper/TopicNav", () => ({ TopicNav: () => null }));
vi.mock("@/components/newspaper/NewsCard", () => ({
  NewsCard: ({ card }: { card: Card }) => <article data-id={card.id} />,
}));

const { TopicPage } = await import("@/components/newspaper/TopicPage");
const { COUNTRIES_TOPIC } = await import("@/config/countries");

function card(id: string, subtopic: string | null, topic: Topic = COUNTRIES_TOPIC): Card {
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
    severity: 3,
    frontPageRank: null,
  };
}

const CARDS = [card("k1", "Kenya"), card("u1", "Uganda")];

function page(panel?: React.ReactNode, country?: string) {
  return (
    <TopicPage cards={CARDS} topic={COUNTRIES_TOPIC} userTopics={[COUNTRIES_TOPIC]} country={country} panel={panel} />
  );
}

describe("TopicPage panel band", () => {
  it("renders exactly as before when no panel is passed", () => {
    const html = renderToString(page());
    expect(html).not.toContain("<!--$-->");
    expect(html).not.toContain("data-panel");
  });

  it("places the panel after the heading and the country filter, before the cards", () => {
    const html = renderToString(page(<div data-panel="yes" />, "kenya"));
    const heading = html.indexOf("<h1");
    const filter = html.indexOf('aria-label="Filter by country"');
    const panel = html.indexOf('data-panel="yes"');
    const firstCard = html.indexOf("<article");
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(filter).toBeGreaterThan(heading);
    expect(panel).toBeGreaterThan(filter);
    expect(firstCard).toBeGreaterThan(panel);
  });

  it("streams the cards while a panel is still waiting, with nothing shown in its place", async () => {
    const never = new Promise<never>(() => {});
    function WaitingPanel() {
      use(never);
      return <div data-panel="late" />;
    }

    const stream = await renderToReadableStream(page(<WaitingPanel />));
    const reader = stream.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const shell = new TextDecoder().decode(value);

    expect(shell).toContain('data-id="k1"');
    expect(shell).toContain('data-id="u1"');
    expect(shell).not.toContain("data-panel");
    // The pending boundary's marker, with an empty fallback inside it.
    expect(shell).toMatch(/<!--\$\?--><template[^>]*><\/template><!--\/\$-->/);
  });
});
