import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import nextConfig from "../../next.config";
import { slugToTopic, topicToSlug } from "@/lib/topicSlug";

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
// parameters fill the destination.
async function resolve(path: string): Promise<{ to: string; permanent: boolean } | null> {
  for (const rule of await redirects()) {
    const hit = match(rule.source, { decode: decodeURIComponent })(path);
    if (hit) return { to: compile(rule.destination)(hit.params), permanent: rule.permanent };
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
