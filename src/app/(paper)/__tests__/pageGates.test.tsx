import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { SOURCES, TOPICS } from "@/types";

// The four reader pages send a profile with no topics to /onboarding. Zero
// preferred sources is a finished profile ("every source for my topics"),
// so it must render instead. Each page is an async server component, called
// here as a function: the returned element tree is enough to see whether it
// rendered and what it handed its child, with no DOM needed.

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", () => ({ getUserProfile: mocks.getUserProfile }));
vi.mock("@/lib/digests", () => ({
  getTodayDigest: vi.fn(async () => null),
  getLatestGeneratedAtForUser: vi.fn(async () => null),
  getDigestForDate: vi.fn(async () => null),
  getCardsForTopicOnDate: vi.fn(async () => []),
  digestExistsForDate: vi.fn(async () => true),
  todayDateString: vi.fn(() => "2026-10-02"),
}));
vi.mock("@/lib/topicSlug", () => ({ slugToTopic: vi.fn(() => TOPICS[0]) }));
vi.mock("@/components/newspaper/FrontPage", () => ({ FrontPage: () => null }));
vi.mock("@/components/newspaper/TopicPage", () => ({ TopicPage: () => null }));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const { default: Home } = await import("@/app/(paper)/page");
const { default: TopicRoutePage } = await import("@/app/(paper)/topic/[slug]/page");
const { default: HistoryDatePage } = await import("@/app/(paper)/history/[date]/page");
const { default: HistoryTopicPage } = await import(
  "@/app/(paper)/history/[date]/topic/[slug]/page"
);
const { TopicPage } = await import("@/components/newspaper/TopicPage");

const PAST = "2026-09-01";
const READER_TOPICS = TOPICS.slice(0, 3);

const pages: Array<{ name: string; render: () => Promise<unknown> }> = [
  { name: "front page", render: () => Home() },
  {
    name: "topic page",
    render: () => TopicRoutePage({ params: Promise.resolve({ slug: "any" }) }),
  },
  {
    name: "history date page",
    render: () => HistoryDatePage({ params: Promise.resolve({ date: PAST }) }),
  },
  {
    name: "history topic page",
    render: () =>
      HistoryTopicPage({ params: Promise.resolve({ date: PAST, slug: "any" }) }),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

describe.each(pages)("$name onboarding gate", ({ render }) => {
  it("renders for a reader with topics and zero preferred sources", async () => {
    mocks.getUserProfile.mockResolvedValue({
      topics: READER_TOPICS,
      preferredSources: [],
      timeZone: "UTC",
    });

    await expect(render()).resolves.toBeTruthy();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("still redirects a reader with zero topics to onboarding", async () => {
    mocks.getUserProfile.mockResolvedValue({
      topics: [],
      preferredSources: SOURCES.slice(0, 2),
      timeZone: "UTC",
    });

    await expect(render()).rejects.toThrow("REDIRECT:/onboarding");
  });
});

describe("topic routes pass the reader's preferred sources to TopicPage", () => {
  it.each([
    ["topic page", pages[1]],
    ["history topic page", pages[3]],
  ])("%s", async (_name, page) => {
    const preferred = SOURCES.slice(0, 2);
    mocks.getUserProfile.mockResolvedValue({
      topics: READER_TOPICS,
      preferredSources: preferred,
      timeZone: "UTC",
    });

    const tree = (await page.render()) as ReactNode;
    const topicPage = findElement(tree, TopicPage) as
      | ReactElement<{ preferredSources?: unknown }>
      | undefined;
    expect(topicPage?.props.preferredSources).toEqual(preferred);
  });
});
