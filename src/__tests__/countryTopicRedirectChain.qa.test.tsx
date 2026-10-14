import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import nextConfig from "../../next.config";

// The six retired single-country topics' old links, end to end: Next's own
// redirect resolution, then the history page's today-redirect, compared with
// the URL CountryFilter itself renders, and the Countries page's filter
// finding a card the migration refiled.

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  getCardsForTopicOnDate: vi.fn(async () => []),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/digests", () => ({
  getCardsForTopicOnDate: mocks.getCardsForTopicOnDate,
  digestExistsForDate: vi.fn(async () => true),
  todayDateString: () => "2026-10-14",
}));
vi.mock("@/lib/profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile")>()),
  getUserProfile: mocks.getUserProfile,
}));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const TODAY = "2026-10-14";
const { default: HistoryTopicPage } = await import("@/app/(paper)/history/[date]/topic/[slug]/page");
const { CountryFilter } = await import("@/components/newspaper/CountryFilter");
const { filterCountryCards } = await import("@/components/newspaper/TopicPage");
const { slugToTopic } = await import("@/lib/topicSlug");
const { slugToCountry, countryToSlug } = await import("@/config/countryNames");
const profileModule = await vi.importActual<typeof import("@/lib/profile")>("@/lib/profile");

const req = createRequire(import.meta.url);
const loadCustomRoutes = req("next/dist/lib/load-custom-routes").default;
const { defaultConfig } = req("next/dist/server/config-shared");
const { getPathMatch } = req("next/dist/shared/lib/router/utils/path-match");
const { modifyRouteRegex, getRedirectStatus } = req("next/dist/lib/redirect-status");
const { prepareDestination } = req("next/dist/shared/lib/router/utils/prepare-destination");

type Built = { destination: string; status: number; match: (p: string) => Record<string, string> | false };
let routes: Built[] = [];

beforeAll(async () => {
  const config = { ...defaultConfig, ...nextConfig, experimental: { ...defaultConfig.experimental } };
  const { redirects } = await loadCustomRoutes(config);
  routes = redirects.map((item: { source: string; destination: string; internal?: boolean }) => ({
    destination: item.destination,
    status: getRedirectStatus(item),
    match: getPathMatch(item.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex: string) => (item.internal ? regex : modifyRouteRegex(regex, ["/_next"])),
      sensitive: config.experimental.caseSensitiveRoutes,
    }),
  }));
});

function follow(url: string): { hops: { to: string; status: number }[]; final: URL } {
  const hops: { to: string; status: number }[] = [];
  let current = new URL(url, "https://pna.example");
  for (let i = 0; i < 5; i++) {
    const hit = routes.map((r) => ({ r, params: r.match(current.pathname) })).find((x) => x.params);
    if (!hit) break;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: hit.r.destination,
      params: hit.params,
      query: Object.fromEntries(current.searchParams),
    });
    const next = new URL(parsedDestination.pathname, current);
    for (const [k, v] of Object.entries(parsedDestination.query as Record<string, string | string[]>)) {
      for (const one of Array.isArray(v) ? v : [v]) next.searchParams.append(k, one);
    }
    hops.push({ to: next.pathname + next.search, status: hit.r.status });
    current = next;
  }
  return { hops, final: current };
}

function countryFilterHref(pageHref: string, country: string): string {
  const html = renderToStaticMarkup(createElement(CountryFilter, { countries: [country], activeSlug: null, pageHref }));
  const link = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&")).find((h) => h.includes("?country="));
  if (!link) throw new Error("no country link");
  return link;
}

const SIX: [slug: string, topic: string, country: string][] = [
  ["us-politics", "US Politics", "United States"],
  ["us-finance", "US Finance", "United States"],
  ["uk-politics", "UK Politics", "United Kingdom"],
  ["french-politics", "French Politics", "France"],
  ["morocco-politics", "Morocco Politics", "Morocco"],
  ["morocco-finance", "Morocco Finance", "Morocco"],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Tech/AI", "Countries"], preferredSources: [], countries: ["United States"], timeZone: "UTC" });
});

describe("an old single-country history link for today", () => {
  it.each(SIX)("/history/<today>/topic/%s: config 308, then the page's today-redirect, lands on CountryFilter's own live URL", async (slug, _topic, country) => {
    const { final, hops } = follow(`/history/${TODAY}/topic/${slug}`);
    expect(hops.map((h) => h.status)).toEqual([308]);
    expect(final.pathname + final.search).toBe(countryFilterHref(`/history/${TODAY}/topic/countries`, country));
    const [, , date, , landed] = final.pathname.split("/");
    const live = countryFilterHref("/topic/countries", country);
    await expect(
      HistoryTopicPage({
        params: Promise.resolve({ date, slug: landed }),
        searchParams: Promise.resolve(Object.fromEntries(final.searchParams)),
      })
    ).rejects.toThrow(new Error(`REDIRECT:${live}`));
    // And the live URL is final: no config rule fires on it.
    expect(follow(live).hops).toEqual([]);
  });
});

describe("an old single-country history link for a past day", () => {
  it.each(SIX)("/history/2026-10-01/topic/%s renders the Countries page for that day with the country filter on", async (slug, _topic, country) => {
    const { final } = follow(`/history/2026-10-01/topic/${slug}`);
    const [, , date, , landed] = final.pathname.split("/");
    const el = (await HistoryTopicPage({
      params: Promise.resolve({ date, slug: landed }),
      searchParams: Promise.resolve(Object.fromEntries(final.searchParams)),
    })) as { props: { children: { props: Record<string, unknown> }[] } };
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getCardsForTopicOnDate).toHaveBeenCalledWith(expect.anything(), "u", "2026-10-01", "Countries");
    const topicPage = el.props.children[1].props;
    expect(topicPage.topic).toBe("Countries");
    expect(slugToCountry(topicPage.country as string)).toBe(country);
  });

  it.each(SIX)("the migration's refiled %s card is what ?country= picks out on the Countries page", (slug, topic, country) => {
    const { final } = follow(`/topic/${slug}`);
    const card = (id: string, subtopic: string) => ({ id, topic: "Countries", subtopic, severity: 3, publishedAt: "2026-10-01T00:00:00Z", sources: [] }) as never;
    const r = filterCountryCards([card("refiled", country), card("other", "Kenya")], final.searchParams.get("country") ?? undefined);
    expect(r.activeSlug, topic).toBe(countryToSlug(country));
    expect(r.shown.map((c: { id: string }) => c.id)).toEqual(["refiled"]);
  });
});

describe("the retired slugs are dead to the app", () => {
  it.each(SIX)("%s no longer resolves to a topic, so only the config redirect can serve it", (slug) => {
    expect(slugToTopic(slug)).toBeNull();
  });

  it("an unmigrated reader holding only retired topics is sent to onboarding by the history page", async () => {
    mocks.getUserProfile.mockResolvedValue({ topics: [], preferredSources: [], countries: [], timeZone: "UTC" });
    const { final } = follow("/history/2026-10-01/topic/us-politics");
    const [, , date, , landed] = final.pathname.split("/");
    await expect(
      HistoryTopicPage({ params: Promise.resolve({ date, slug: landed }), searchParams: Promise.resolve(Object.fromEntries(final.searchParams)) })
    ).rejects.toThrow(new Error("REDIRECT:/onboarding"));
  });
});

describe("a form left open from before the deploy", () => {
  it.each(SIX)("a save still naming %s is refused whole", (_slug, topic) => {
    const r = profileModule.ProfileInput.safeParse({ topics: [topic, "Tech/AI", "Science", "Space"], preferredSources: [], countries: [] });
    expect(r.success).toBe(false);
  });

  it.each(["RFI (FR)", "Fortune", "MarketWatch"])("a save still naming the removed outlet %s is refused whole", (source) => {
    const r = profileModule.ProfileInput.safeParse({ topics: ["Tech/AI", "Science", "Space"], preferredSources: [source], countries: [] });
    expect(r.success).toBe(false);
  });
});
