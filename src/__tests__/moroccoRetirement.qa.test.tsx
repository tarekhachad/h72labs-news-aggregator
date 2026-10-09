import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import nextConfig from "../../next.config";
import { TOPICS } from "@/types";

// The retired Morocco topic: the redirect chain end to end,
// the Countries page finding a refiled card, the profile read for a reader
// whose only stored topic is the retired one, and the leftovers check.

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
vi.mock("@/lib/digests", () => ({
  getCardsForTopicOnDate: vi.fn(async () => []),
  digestExistsForDate: vi.fn(async () => true),
  todayDateString: () => "2026-10-02",
}));
vi.mock("@/lib/profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile")>()),
  getUserProfile: mocks.getUserProfile,
}));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const TODAY = "2026-10-02";

const { default: HistoryTopicPage } = await import("@/app/(paper)/history/[date]/topic/[slug]/page");
const { CountryFilter } = await import("@/components/newspaper/CountryFilter");
const { filterCountryCards } = await import("@/components/newspaper/TopicPage");
const profileModule = await vi.importActual<typeof import("@/lib/profile")>("@/lib/profile");
const { slugToTopic } = await import("@/lib/topicSlug");
const { FEEDS } = await import("@/config/feeds");
const { TOPIC_GROUPS } = await import("@/config/topicGroups");
const { TOPIC_DESCRIPTIONS } = await import("@/config/topicDescriptions");

// --- Next's own redirect resolution (same pieces as redirects.next.test.ts) ---
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: ["Countries", "Tech/AI"], preferredSources: [], countries: ["Morocco"], timeZone: "UTC" });
});

describe("QA: an old Morocco link, end to end", () => {
  it("today's history link: config redirect, then the page's today-redirect, keeps the country and lands on CountryFilter's own URL", async () => {
    const { final, hops } = follow(`/history/${TODAY}/topic/morocco`);
    expect(hops.map((h) => h.status)).toEqual([308]);
    const [, , date, , slug] = final.pathname.split("/");
    await expect(
      HistoryTopicPage({
        params: Promise.resolve({ date, slug }),
        searchParams: Promise.resolve(Object.fromEntries(final.searchParams)),
      })
    ).rejects.toThrow(new Error(`REDIRECT:${countryFilterHref("/topic/countries", "Morocco")}`));
  });

  it("an upper-case, trailing-slash history link lands on the filtered Countries page", () => {
    const { final, hops } = follow("/HISTORY/2026-09-14/TOPIC/MOROCCO/");
    expect(hops.every((h) => h.status === 308)).toBe(true);
    expect(final.pathname + final.search).toBe(countryFilterHref("/history/2026-09-14/topic/countries", "Morocco"));
  });

  it("an incoming ?country=… does not override the redirect's own country", () => {
    const { final } = follow("/topic/morocco?country=kenya");
    expect(final.pathname).toBe("/topic/countries");
    expect(final.searchParams.getAll("country")).toEqual(["morocco"]);
  });

  it("the landing slug resolves to the Countries topic, not a dead slug", () => {
    expect(slugToTopic("countries")).toBe("Countries");
    expect(slugToTopic("morocco")).toBeNull();
  });
});

describe("QA: a refiled card on the Countries page", () => {
  const card = (id: string, subtopic: string | null, topic = "Countries") =>
    ({ id, topic, subtopic, severity: 3, publishedAt: "2026-10-01T00:00:00Z", sources: [] }) as never;

  it("the migration's (Countries, Morocco) card is found by the redirect's ?country=morocco", () => {
    const r = filterCountryCards([card("a", "Morocco"), card("b", "Kenya")], "morocco");
    expect(r.activeSlug).toBe("morocco");
    expect(r.shown.map((c: { id: string }) => c.id)).toEqual(["a"]);
    expect(r.countries).toEqual(["Kenya", "Morocco"]);
  });

  it("with no Morocco card that day the filter falls back to every card rather than an empty page", () => {
    const r = filterCountryCards([card("b", "Kenya")], "morocco");
    expect(r.activeSlug).toBeNull();
    expect(r.shown).toHaveLength(1);
  });
});

describe("QA: profile read between deploy and migration", () => {
  function fake(rows: { topics: string[]; countries?: string[] }): SupabaseClient {
    const result = (table: string) => {
      if (table === "user_topics") return { data: rows.topics.map((topic) => ({ topic })), error: null };
      if (table === "user_preferred_sources") return { data: [], error: null };
      if (table === "user_subtopics") return { data: (rows.countries ?? []).map((subtopic) => ({ subtopic })), error: null };
      return { data: null, error: null };
    };
    return {
      from: (table: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => result(table),
          then: (resolve: (v: unknown) => unknown) => resolve(result(table)),
        };
        return chain;
      },
    } as unknown as SupabaseClient;
  }

  it("a reader whose only stored topic is Morocco reads as having no topics (the onboarding case the migration comment names)", async () => {
    const p = await profileModule.getUserProfile(fake({ topics: ["Morocco"] }), "u");
    expect(p.topics).toEqual([]);
  });

  it("a reader with Morocco plus the Morocco country keeps Countries and the country", async () => {
    const p = await profileModule.getUserProfile(fake({ topics: ["Morocco", "Countries", "Science"], countries: ["Morocco"] }), "u");
    expect(p.topics).toEqual(["Science", "Countries"].sort((a, b) => TOPICS.indexOf(a as never) - TOPICS.indexOf(b as never)));
    expect(p.countries).toEqual(["Morocco"]);
  });

  it("a save that still names Morocco (a form open from before the deploy) is refused, not silently half-saved", () => {
    const r = profileModule.ProfileInput.safeParse({ topics: ["Morocco", "Tech/AI", "Science", "Space"], preferredSources: [], countries: [] });
    expect(r.success).toBe(false);
  });
});

describe("QA: no catalog surface still knows Morocco as a topic", () => {
  it("TOPICS, FEEDS, groups and descriptions all drop it; Politics and Finance stay", () => {
    expect(TOPICS as readonly string[]).not.toContain("Morocco");
    expect(Object.keys(FEEDS)).not.toContain("Morocco");
    expect(TOPIC_GROUPS.flatMap((g) => g.topics as readonly string[])).not.toContain("Morocco");
    expect(Object.keys(TOPIC_DESCRIPTIONS)).not.toContain("Morocco");
    for (const kept of ["Morocco Politics", "Morocco Finance"]) {
      expect(TOPICS as readonly string[]).toContain(kept);
      expect(Object.keys(FEEDS)).toContain(kept);
    }
  });

  it("every grouped topic is in TOPICS and every TOPIC but Countries is grouped exactly once", () => {
    const grouped = TOPIC_GROUPS.flatMap((g) => g.topics as readonly string[]);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(TOPICS.filter((t) => t !== "Countries").sort());
  });
});
