import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import nextConfig from "../../next.config";
import { slugToTopic, topicToSlug } from "@/lib/topicSlug";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COUNTRIES_TOPIC, slugToCountry } from "@/config/countries";
import { CountryFilter } from "@/components/newspaper/CountryFilter";

// path-to-regexp, the library Next matches `redirects()` entries with, at its
// defaults; redirects.next.test.ts runs the same paths through Next's own
// router options. Next ships it without type declarations, hence the require
// and the hand-written shape.
const { compile, match } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as {
  match: (
    pattern: string,
    options: { decode: (segment: string) => string }
  ) => (path: string) => { params: Record<string, string> } | false;
  compile: (pattern: string) => (params: Record<string, string>) => string;
};

type Redirect = { source: string; destination: string; permanent: boolean };

async function redirects(): Promise<Redirect[]> {
  if (!nextConfig.redirects) throw new Error("next.config.ts has no redirects()");
  return (await nextConfig.redirects()) as Redirect[];
}

// Where a request path ends up, or null if no redirect matches it. Mirrors
// how Next resolves one: the first matching source wins, and its named
// parameters fill the destination's path. A destination's query string is
// not a pattern, so Next splits it off before compiling the path, and so does
// this.
async function resolve(path: string): Promise<{ to: string; permanent: boolean } | null> {
  for (const rule of await redirects()) {
    const hit = match(rule.source, { decode: decodeURIComponent })(path);
    if (!hit) continue;
    const [pathname, query] = rule.destination.split("?");
    const to = compile(pathname)(hit.params) + (query === undefined ? "" : `?${query}`);
    return { to, permanent: rule.permanent };
  }
  return null;
}

describe("old football links", () => {
  it("sends the old topic page to the football page, permanently", async () => {
    expect(await resolve("/topic/european-football")).toEqual({
      to: "/topic/football",
      permanent: true,
    });
  });

  it("sends an old history topic page to the same day's football page, permanently", async () => {
    expect(await resolve("/history/2026-09-14/topic/european-football")).toEqual({
      to: "/history/2026-09-14/topic/football",
      permanent: true,
    });
  });

  it("lands on the slug the football topic actually uses", async () => {
    const landing = await resolve("/topic/european-football");
    expect(landing?.to).toBe(`/topic/${topicToSlug("Football")}`);
    expect(slugToTopic(landing!.to.split("/").pop()!)).toBe("Football");
  });

  // A redirect whose destination matched a source would loop forever.
  it("never redirects the pages it sends readers to", async () => {
    expect(await resolve("/topic/football")).toBeNull();
    expect(await resolve("/history/2026-09-14/topic/football")).toBeNull();
  });

  it("leaves every other topic page alone", async () => {
    expect(await resolve("/topic/american-football")).toBeNull();
    expect(await resolve("/history/2026-09-14/topic/tennis")).toBeNull();
    expect(await resolve("/topic/european-football/extra")).toBeNull();
  });
});

// The Countries page's own Morocco link, as CountryFilter renders it on the
// given page. A redirect must land exactly there, or the filter wouldn't show
// as picked.
function countryFilterHref(pageHref: string, country: string): string {
  const html = renderToStaticMarkup(
    createElement(CountryFilter, { countries: [country], activeSlug: null, pageHref })
  );
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
  const link = hrefs.find((href) => href.includes("?country="));
  if (!link) throw new Error(`no country link in ${html}`);
  return link;
}

describe("old Morocco topic links", () => {
  const countriesPage = `/topic/${topicToSlug(COUNTRIES_TOPIC)}`;

  it("sends the old topic page to the Countries page filtered to Morocco, permanently", async () => {
    expect(await resolve("/topic/morocco")).toEqual({
      to: countryFilterHref(countriesPage, "Morocco"),
      permanent: true,
    });
    expect(countryFilterHref(countriesPage, "Morocco")).toBe("/topic/countries?country=morocco");
  });

  it("sends an old history topic page to the same day's Countries page filtered to Morocco, permanently", async () => {
    const day = "/history/2026-09-14";
    expect(await resolve(`${day}/topic/morocco`)).toEqual({
      to: countryFilterHref(`${day}${countriesPage}`, "Morocco"),
      permanent: true,
    });
  });

  it("lands on a page that exists, filtered by a country that exists", async () => {
    const to = new URL((await resolve("/topic/morocco"))!.to, "https://pna.example");
    expect(slugToTopic(to.pathname.split("/").pop()!)).toBe(COUNTRIES_TOPIC);
    expect(slugToCountry(to.searchParams.get("country")!)).toBe("Morocco");
    expect(slugToTopic("morocco")).toBeNull();
  });

  it("leaves the Morocco Politics and Morocco Finance pages, and the destination, alone", async () => {
    expect(await resolve("/topic/morocco-politics")).toBeNull();
    expect(await resolve("/topic/morocco-finance")).toBeNull();
    expect(await resolve("/history/2026-09-14/topic/morocco-politics")).toBeNull();
    expect(await resolve("/topic/countries")).toBeNull();
    expect(await resolve("/topic/morocco/extra")).toBeNull();
  });
});
