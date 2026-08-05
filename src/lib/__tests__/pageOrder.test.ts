import { describe, it, expect } from "vitest";
import { buildPageOrder, pagesBetween } from "@/lib/pageOrder";

describe("buildPageOrder", () => {
  it("puts the front page first, then topics in the given order", () => {
    expect(buildPageOrder(["Tech/AI", "US Politics"])).toEqual([
      "/",
      "/topic/tech-ai",
      "/topic/us-politics",
    ]);
  });

  it("scopes every entry to basePath when given (history dates)", () => {
    expect(buildPageOrder(["Tech/AI"], "/history/2026-08-01")).toEqual([
      "/history/2026-08-01",
      "/history/2026-08-01/topic/tech-ai",
    ]);
  });

  it("returns just the front page for a user with no topics", () => {
    expect(buildPageOrder([])).toEqual(["/"]);
  });
});

describe("pagesBetween", () => {
  const order = buildPageOrder(["Tech/AI", "US Politics", "Geopolitics"]);
  // order: ["/", "/topic/tech-ai", "/topic/us-politics", "/topic/geopolitics"]

  it("is 0 for the same page", () => {
    expect(pagesBetween("/", "/", order)).toBe(0);
  });

  it("is 1 for adjacent pages, in either direction", () => {
    expect(pagesBetween("/", "/topic/tech-ai", order)).toBe(1);
    expect(pagesBetween("/topic/tech-ai", "/", order)).toBe(1);
  });

  it("counts intervening pages for a multi-page jump", () => {
    expect(pagesBetween("/", "/topic/geopolitics", order)).toBe(3);
    expect(pagesBetween("/topic/tech-ai", "/topic/geopolitics", order)).toBe(2);
  });

  it("returns null when either href isn't part of the sequence", () => {
    expect(pagesBetween("/saved", "/", order)).toBeNull();
    expect(pagesBetween("/", "/saved", order)).toBeNull();
    expect(pagesBetween("/topic/basketball", "/", order)).toBeNull();
  });
});
