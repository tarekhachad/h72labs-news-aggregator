import { beforeEach, describe, expect, it, vi } from "vitest";
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

const { default: HistoryTopicPage } = await import("@/app/(paper)/history/[date]/topic/[slug]/page");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: TOPICS.slice(0, 3), preferredSources: [], countries: [], timeZone: "UTC" });
});

const go = (searchParams: Record<string, string | string[] | undefined>, date = "2026-10-02") =>
  HistoryTopicPage({ params: Promise.resolve({ date, slug: "countries" }), searchParams: Promise.resolve(searchParams) });

describe("QA round 2: history today-redirect country param", () => {
  it.each([
    [{ country: "Kenya" }, "/topic/countries?country=Kenya"],
    [{ country: "côte d'Ivoire" }, "/topic/countries?country=c%C3%B4te%20d'Ivoire"],
    [{ country: " " }, "/topic/countries?country=%20"],
    [{ country: "0" }, "/topic/countries?country=0"],
    [{ country: "" }, "/topic/countries"],
    [{ country: [] as string[] }, "/topic/countries"],
    [{ country: ["Kenya"] }, "/topic/countries"],
    [{ country: undefined }, "/topic/countries"],
    [{}, "/topic/countries"],
    [{ other: "x" }, "/topic/countries"],
  ])("%j -> %s", async (params, url) => {
    await expect(go(params)).rejects.toThrow(`REDIRECT:${url}`);
    expect(mocks.redirect).toHaveBeenCalledWith(url);
  });

  it("a past date does not redirect for an empty country", async () => {
    await expect(go({ country: "" }, "2026-09-01")).resolves.toBeDefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
