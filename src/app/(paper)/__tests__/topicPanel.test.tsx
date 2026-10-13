import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { Card } from "@/types";
import { TOPICS } from "@/types";

// Today's topic route hands TopicPage the Countries fact box only when the
// page is filtered to one country among today's cards. The route is called as
// a function, as in countryParam.test.tsx, and the panel element it builds is
// inspected, not rendered: no upstream call happens here.

const mocks = vi.hoisted(() => ({
  getCardsForTopicOnDate: vi.fn(),
  getCountryFacts: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
  })),
}));
vi.mock("@/lib/profile", () => ({
  getUserProfile: vi.fn(async () => ({
    topics: TOPICS.slice(0, 3),
    preferredSources: [],
    countries: [],
    timeZone: "UTC",
  })),
}));
vi.mock("@/lib/digests", () => ({
  getCardsForTopicOnDate: mocks.getCardsForTopicOnDate,
  digestExistsForDate: vi.fn(async () => true),
  todayDateString: vi.fn(() => "2026-10-13"),
}));
vi.mock("@/lib/panels/countryFacts", () => ({ getCountryFacts: mocks.getCountryFacts }));
vi.mock("@/components/newspaper/TopicPage", () => ({ TopicPage: () => null }));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const { default: TopicRoutePage } = await import("@/app/(paper)/topic/[slug]/page");
const { default: HistoryTopicPage } = await import("@/app/(paper)/history/[date]/topic/[slug]/page");
const { TopicPage } = await import("@/components/newspaper/TopicPage");
const { CountryFactsPanel } = await import("@/components/newspaper/panels/CountryFactsPanel");

function card(id: string, subtopic: string | null): Card {
  return {
    id,
    topic: "Countries",
    subtopic,
    title: id,
    shortSummary: "",
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-13T08:00:00Z",
    generatedAt: "2026-10-13T08:00:00Z",
    bookmarked: false,
    severity: 3,
    frontPageRank: null,
  };
}

function findElement(node: ReactNode, type: unknown): ReactElement | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return undefined;
  }
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === type) return element;
  return findElement(element.props?.children, type);
}

async function panelFor(slug: string, country?: string | string[]) {
  const tree = (await TopicRoutePage({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve(country === undefined ? {} : { country }),
  })) as ReactNode;
  const page = findElement(tree, TopicPage) as ReactElement<{ panel?: ReactNode }> | undefined;
  expect(page).toBeDefined();
  return page!.props.panel as ReactElement<{ country: string }> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCardsForTopicOnDate.mockResolvedValue([card("k", "Kenya"), card("c", "Côte d'Ivoire")]);
});

describe("today's topic route: the Countries fact box", () => {
  it("passes the box for the filtered country, named from COUNTRIES", async () => {
    const panel = await panelFor("countries", "cote-d-ivoire");
    expect(panel?.type).toBe(CountryFactsPanel);
    expect(panel?.props.country).toBe("Côte d'Ivoire");
  });

  it.each([
    ["the unfiltered page", undefined],
    ["a country with no card today", "morocco"],
    ["a slug naming no country", "<script>"],
    ["a repeated param", ["kenya", "kenya"]],
  ])("passes no panel for %s", async (_name, country) => {
    expect(await panelFor("countries", country)).toBeUndefined();
  });

  it("passes no panel on another topic, even with ?country=", async () => {
    const other = TOPICS.find((t) => t !== "Countries")!;
    const slug = other.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    mocks.getCardsForTopicOnDate.mockResolvedValue([{ ...card("k", "Kenya"), topic: other }]);
    expect(await panelFor(slug, "kenya")).toBeUndefined();
  });

  it("never fetches facts while building the page: the panel loads them inside its own boundary", async () => {
    await panelFor("countries", "kenya");
    expect(mocks.getCountryFacts).not.toHaveBeenCalled();
  });

  it("history topic pages pass no panel", async () => {
    const tree = (await HistoryTopicPage({
      params: Promise.resolve({ date: "2026-09-01", slug: "countries" }),
      searchParams: Promise.resolve({ country: "kenya" }),
    })) as ReactNode;
    const page = findElement(tree, TopicPage) as ReactElement<{ panel?: ReactNode }>;
    expect(page.props.panel).toBeUndefined();
  });
});
