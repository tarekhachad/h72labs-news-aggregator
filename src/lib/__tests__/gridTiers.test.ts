import { describe, it, expect } from "vitest";
import { tierForSeverity, tierForFrontPageRank } from "@/lib/gridTiers";

describe("tierForSeverity", () => {
  it.each([
    [5, "hero"],
    [4, "large"],
    [3, "medium"],
    [2, "medium"],
    [1, "small"],
  ] as const)("maps severity %i to tier %s", (severity, expected) => {
    expect(tierForSeverity(severity)).toBe(expected);
  });

  it("clamps out-of-range values defensively instead of throwing", () => {
    expect(tierForSeverity(0)).toBe("small");
    expect(tierForSeverity(-3)).toBe("small");
    expect(tierForSeverity(9)).toBe("hero");
  });

  it("rounds fractional values before mapping", () => {
    expect(tierForSeverity(4.6)).toBe("hero");
    expect(tierForSeverity(4.4)).toBe("large");
  });
});

describe("tierForFrontPageRank", () => {
  it.each([
    [1, "hero"],
    [2, "large"],
    [3, "large"],
    [4, "medium"],
    [5, "small"],
    [6, "small"],
  ] as const)("maps front-page rank %i to tier %s", (rank, expected) => {
    expect(tierForFrontPageRank(rank)).toBe(expected);
  });

  it("clamps out-of-range values defensively instead of throwing", () => {
    expect(tierForFrontPageRank(0)).toBe("hero");
    expect(tierForFrontPageRank(99)).toBe("small");
  });
});
