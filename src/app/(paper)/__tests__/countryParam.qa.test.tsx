import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { TOPICS } from "@/types";

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
  getCardsForTopicOnDate: vi.fn(async () => []),
  digestExistsForDate: vi.fn(async () => true),
  todayDateString: () => "2026-10-02",
}));
vi.mock("@/components/newspaper/TopicPage", () => ({ TopicPage: () => null }));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const { default: TopicRoutePage } = await import("@/app/(paper)/topic/[slug]/page");
const { default: HistoryTopicPage } = await import("@/app/(paper)/history/[date]/topic/[slug]/page");
const { TopicPage } = await import("@/components/newspaper/TopicPage");

function find(node: ReactNode, type: unknown): ReactElement | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const c of node) {
      const f = find(c, type);
      if (f) return f;
    }
    return undefined;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) return el;
  return find(el.props?.children, type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: TOPICS.slice(0, 3), preferredSources: [], countries: [], timeZone: "UTC" });
});

describe("QA: country param on the routes", () => {
  it("history today-redirect keeps a country needing encoding, once-encoded", async () => {
    await expect(
      HistoryTopicPage({
        params: Promise.resolve({ date: "2026-10-02", slug: "countries" }),
        searchParams: Promise.resolve({ country: "a&b=c d" }),
      })
    ).rejects.toThrow("REDIRECT:/topic/countries?country=a%26b%3Dc%20d");
  });

  it("history today-redirect drops a repeated country param (array)", async () => {
    await expect(
      HistoryTopicPage({
        params: Promise.resolve({ date: "2026-10-02", slug: "countries" }),
        searchParams: Promise.resolve({ country: ["a", "b"] }),
      })
    ).rejects.toThrow(/^REDIRECT:\/topic\/countries$/);
  });

  it("an empty country leaves no dangling '?country=' on the redirect", async () => {
    await expect(
      HistoryTopicPage({
        params: Promise.resolve({ date: "2026-10-02", slug: "countries" }),
        searchParams: Promise.resolve({ country: "" }),
      })
    ).rejects.toThrow(/^REDIRECT:\/topic\/countries$/);
  });

  it("a bad slug still redirects before the country param matters", async () => {
    await expect(
      HistoryTopicPage({
        params: Promise.resolve({ date: "2026-10-02", slug: "nonsense" }),
        searchParams: Promise.resolve({ country: "kenya" }),
      })
    ).rejects.toThrow(/REDIRECT:\/history/);
  });

  it("past-day history page passes country and the past-day basePath", async () => {
    const tree = await HistoryTopicPage({
      params: Promise.resolve({ date: "2026-09-01", slug: "countries" }),
      searchParams: Promise.resolve({ country: "kenya" }),
    });
    const el = find(tree as ReactNode, TopicPage) as ReactElement<{ country?: string; basePath?: string }>;
    expect(el.props.country).toBe("kenya");
    expect(el.props.basePath).toBe("/history/2026-09-01");
  });

  it("live topic page renders for a non-Countries slug with a country param", async () => {
    await expect(
      TopicRoutePage({
        params: Promise.resolve({ slug: "tech-ai" }),
        searchParams: Promise.resolve({ country: "kenya" }),
      })
    ).resolves.toBeTruthy();
  });
});
