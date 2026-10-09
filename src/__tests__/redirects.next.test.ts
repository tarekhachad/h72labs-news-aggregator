import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import nextConfig from "../../next.config";

// Resolves a request through the same pieces Next 16's router
// server uses for config redirects, rather than a bare path-to-regexp call:
//  - loadCustomRoutes (adds Next's own trailing-slash redirect in front),
//  - getPathMatch with the options filesystem.js's buildCustomRoute passes
//    (strict: true, sensitive: experimental.caseSensitiveRoutes),
//  - prepareDestination with appendParamsToQuery: false, as resolve-routes.js
//    calls it for redirects, so the incoming query string is carried over.

const req = createRequire(import.meta.url);
const loadCustomRoutes = req("next/dist/lib/load-custom-routes").default;
const { defaultConfig } = req("next/dist/server/config-shared");
const { getPathMatch } = req("next/dist/shared/lib/router/utils/path-match");
const { modifyRouteRegex, getRedirectStatus } = req("next/dist/lib/redirect-status");
const { prepareDestination } = req("next/dist/shared/lib/router/utils/prepare-destination");

type Built = {
  destination: string;
  status: number;
  match: (path: string) => Record<string, string> | false;
};

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

function follow(url: string): { hops: { to: string; status: number }[]; final: string } {
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
    for (const [k, v] of Object.entries(parsedDestination.query as Record<string, string>)) next.searchParams.set(k, v);
    hops.push({ to: next.pathname + next.search, status: hit.r.status });
    current = next;
  }
  return { hops, final: current.pathname + current.search };
}

describe("football redirects, resolved the way Next's router does", () => {
  it("sends /topic/european-football to /topic/football with a 308", () => {
    expect(follow("/topic/european-football")).toEqual({
      hops: [{ to: "/topic/football", status: 308 }],
      final: "/topic/football",
    });
  });

  it("carries the date across for history pages", () => {
    expect(follow("/history/2026-09-14/topic/european-football").final).toBe("/history/2026-09-14/topic/football");
  });

  it("handles a trailing slash in two permanent hops", () => {
    const r = follow("/topic/european-football/");
    expect(r.final).toBe("/topic/football");
    expect(r.hops.every((h) => h.status === 308)).toBe(true);
    expect(follow("/history/2026-09-14/topic/european-football/").final).toBe("/history/2026-09-14/topic/football");
  });

  it("keeps the query string", () => {
    expect(follow("/topic/european-football?ref=mail").final).toBe("/topic/football?ref=mail");
  });

  it("matches case-insensitively, as Next does by default", () => {
    expect(follow("/Topic/European-Football").final).toBe("/topic/football");
  });

  it("leaves the destinations and look-alikes alone", () => {
    expect(follow("/topic/football").hops).toEqual([]);
    expect(follow("/topic/american-football").hops).toEqual([]);
    expect(follow("/topic/european-football/extra").hops).toEqual([]);
    expect(follow("/history/2026/09/14/topic/european-football").hops).toEqual([]);
  });
});

describe("Morocco topic redirects, resolved the way Next's router does", () => {
  it("sends /topic/morocco to the Countries page filtered to Morocco with a 308", () => {
    expect(follow("/topic/morocco")).toEqual({
      hops: [{ to: "/topic/countries?country=morocco", status: 308 }],
      final: "/topic/countries?country=morocco",
    });
  });

  it("carries the date across for history pages", () => {
    expect(follow("/history/2026-09-14/topic/morocco").final).toBe(
      "/history/2026-09-14/topic/countries?country=morocco"
    );
  });

  it("handles a trailing slash in two permanent hops", () => {
    const r = follow("/topic/morocco/");
    expect(r.final).toBe("/topic/countries?country=morocco");
    expect(r.hops.every((h) => h.status === 308)).toBe(true);
    expect(follow("/history/2026-09-14/topic/morocco/").final).toBe(
      "/history/2026-09-14/topic/countries?country=morocco"
    );
  });

  it("keeps the incoming query string beside the country", () => {
    const final = new URL(follow("/topic/morocco?ref=mail").final, "https://pna.example");
    expect(final.pathname).toBe("/topic/countries");
    expect(Object.fromEntries(final.searchParams)).toEqual({ country: "morocco", ref: "mail" });
  });

  it("matches case-insensitively, as Next does by default", () => {
    expect(follow("/Topic/Morocco").final).toBe("/topic/countries?country=morocco");
  });

  it("leaves the destination and look-alikes alone", () => {
    expect(follow("/topic/countries?country=morocco").hops).toEqual([]);
    expect(follow("/topic/morocco-politics").hops).toEqual([]);
    expect(follow("/topic/morocco-finance").hops).toEqual([]);
    expect(follow("/topic/morocco/extra").hops).toEqual([]);
    expect(follow("/history/2026/09/14/topic/morocco").hops).toEqual([]);
  });
});
