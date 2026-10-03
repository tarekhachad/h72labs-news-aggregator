import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { TOPICS } from "@/types";

// Both topic routes read `?country=` and hand it to TopicPage, which filters
// the Countries page by it. Each page is an async server component, called
// here as a function and searched for the TopicPage element it returns.

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  todayDateString: vi.fn(() => "2026-10-02"),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/digests", () => ({
  getCardsForTopicOnDate: vi.fn(async () => []),
  digestExistsForDate: vi.fn(async () => true),
  todayDateString: mocks.todayDateString,
}));
vi.mock("@/components/newspaper/TopicPage", () => ({ TopicPage: () => null }));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const { default: TopicRoutePage } = await import("@/app/(paper)/topic/[slug]/page");
const { default: HistoryTopicPage } = await import("@/app/(paper)/history/[date]/topic/[slug]/page");
const { TopicPage } = await import("@/components/newspaper/TopicPage");

const PAST = "2026-09-01";
type Search = { country?: string | string[] };

const routes = [
  {
    name: "topic page",
    render: (searchParams?: Search) =>
      TopicRoutePage({
        params: Promise.resolve({ slug: "countries" }),
        searchParams: searchParams && Promise.resolve(searchParams),
      }),
  },
  {
    name: "history topic page",
    render: (searchParams?: Search) =>
      HistoryTopicPage({
        params: Promise.resolve({ date: PAST, slug: "countries" }),
        searchParams: searchParams && Promise.resolve(searchParams),
      }),
  },
];

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

async function countryProp(render: (s?: Search) => Promise<unknown>, searchParams?: Search) {
  const tree = (await render(searchParams)) as ReactNode;
  const topicPage = findElement(tree, TopicPage) as ReactElement<{ country?: string }> | undefined;
  expect(topicPage).toBeDefined();
  return topicPage!.props.country;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: TOPICS.slice(0, 3),
    preferredSources: [],
    countries: [],
    timeZone: "UTC",
  });
});

describe.each(routes)("$name", ({ render }) => {
  it("passes ?country= to TopicPage", async () => {
    expect(await countryProp(render, { country: "uganda" })).toBe("uganda");
  });

  it("passes nothing without a country, or without searchParams at all", async () => {
    expect(await countryProp(render, {})).toBeUndefined();
    expect(await countryProp(render)).toBeUndefined();
  });

  it("ignores a repeated country param", async () => {
    expect(await countryProp(render, { country: ["uganda", "kenya"] })).toBeUndefined();
  });
});

describe("history topic page for today", () => {
  it("keeps the country filter on its redirect to the live page", async () => {
    await expect(
      HistoryTopicPage({
        params: Promise.resolve({ date: "2026-10-02", slug: "countries" }),
        searchParams: Promise.resolve({ country: "cote-d-ivoire" }),
      })
    ).rejects.toThrow("REDIRECT:/topic/countries?country=cote-d-ivoire");
  });

  it("redirects without a query string when there is no country", async () => {
    await expect(
      HistoryTopicPage({ params: Promise.resolve({ date: "2026-10-02", slug: "countries" }) })
    ).rejects.toThrow(/^REDIRECT:\/topic\/countries$/);
  });
});
