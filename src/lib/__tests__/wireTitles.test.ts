import { describe, it, expect } from "vitest";
import type { Article, Source, Topic } from "@/types";
import { cleanWireTitle, sampleWireTitles, WIRE_TITLE_LIMIT, WIRE_TITLE_MAX_CHARS } from "@/lib/wireTitles";

function article(title: string, topic: string, source: string, subtopic: string | null = null): Article {
  return {
    title,
    snippet: "",
    url: `https://example.com/${encodeURIComponent(title)}`,
    source: source as Source,
    topic: topic as Topic,
    subtopic,
    publishedAt: "2026-10-08T07:00:00Z",
  };
}

describe("cleanWireTitle", () => {
  it("collapses whitespace runs, including newlines and tabs, and trims", () => {
    expect(cleanWireTitle("  Markets\n\n  slide\tas  rates   rise ")).toBe("Markets slide as rates rise");
  });

  it("leaves a title at exactly the cap untouched", () => {
    const exact = "a".repeat(WIRE_TITLE_MAX_CHARS);
    expect(cleanWireTitle(exact)).toBe(exact);
  });

  it("cuts a long title at a word boundary and ends it with an ellipsis, within the cap", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const out = cleanWireTitle(long);
    expect(out.length).toBeLessThanOrEqual(WIRE_TITLE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1)).toBe(out.slice(0, -1).trimEnd());
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    // Ends on a whole word.
    expect(long[out.length - 1]).toBe(" ");
  });

  it("cuts a title with no early space mid-word instead of emptying it", () => {
    const out = cleanWireTitle("x".repeat(500));
    expect(out).toBe(`${"x".repeat(WIRE_TITLE_MAX_CHARS - 1)}…`);
  });

  it("collapses control characters, such as a feed's raw NUL, like whitespace", () => {
    expect(cleanWireTitle("Before\u0000After\u0007\u007f end")).toBe("Before After end");
  });

  it("returns an empty string for whitespace only", () => {
    expect(cleanWireTitle(" \n\t ")).toBe("");
  });
});

describe("sampleWireTitles", () => {
  it("is empty for no articles", () => {
    expect(sampleWireTitles([])).toEqual([]);
  });

  it("returns at most 20 titles by default", () => {
    const many = Array.from({ length: 50 }, (_, i) => article(`Story ${i}`, "Science", "BBC"));
    expect(sampleWireTitles(many)).toHaveLength(WIRE_TITLE_LIMIT);
  });

  it("spreads across reading units instead of taking the first 20 from one", () => {
    const articles = [
      ...Array.from({ length: 30 }, (_, i) => article(`Science ${i}`, "Science", "BBC")),
      ...Array.from({ length: 3 }, (_, i) => article(`Football ${i}`, "Football", "BBC")),
      ...Array.from({ length: 3 }, (_, i) => article(`Kenya ${i}`, "Countries", "BBC", "Kenya")),
      ...Array.from({ length: 3 }, (_, i) => article(`Uganda ${i}`, "Countries", "BBC", "Uganda")),
    ];
    const out = sampleWireTitles(articles);
    expect(out).toHaveLength(20);
    // Every unit's titles are all in, and the busy unit fills the rest.
    for (const prefix of ["Football", "Kenya", "Uganda"]) {
      expect(out.filter((t) => t.startsWith(prefix))).toHaveLength(3);
    }
    expect(out.filter((t) => t.startsWith("Science"))).toHaveLength(11);
    // Round robin: the first four are one from each unit, in arrival order.
    expect(out.slice(0, 4)).toEqual(["Science 0", "Football 0", "Kenya 0", "Uganda 0"]);
  });

  it("treats two countries within Countries as separate units", () => {
    const out = sampleWireTitles(
      [
        article("K1", "Countries", "BBC", "Kenya"),
        article("K2", "Countries", "BBC", "Kenya"),
        article("U1", "Countries", "BBC", "Uganda"),
      ],
      2
    );
    expect(out).toEqual(["K1", "U1"]);
  });

  it("spreads across outlets within a unit", () => {
    const articles = [
      ...Array.from({ length: 10 }, (_, i) => article(`NYT ${i}`, "Science", "NYT")),
      article("BBC 0", "Science", "BBC"),
      article("BBC 1", "Science", "BBC"),
    ];
    expect(sampleWireTitles(articles, 4)).toEqual(["NYT 0", "BBC 0", "NYT 1", "BBC 1"]);
  });

  it("drops duplicates case-insensitively after cleaning, keeping the first", () => {
    const out = sampleWireTitles([
      article("Rates  rise", "Economy", "NYT"),
      article("rates rise", "Economy", "BBC"),
      article("RATES RISE", "Markets", "Reuters"),
      article("Other story", "Markets", "Reuters"),
    ]);
    expect(out).toEqual(["Rates rise", "Other story"]);
  });

  it("skips blank titles without losing that unit's turn", () => {
    const out = sampleWireTitles(
      [article("   ", "Science", "BBC"), article("Real one", "Science", "BBC"), article("Football 0", "Football", "BBC")],
      2
    );
    expect(out).toEqual(["Real one", "Football 0"]);
  });

  it("keeps markup as literal text, untouched (rendering decides it is text)", () => {
    expect(sampleWireTitles([article('<img src=x onerror="alert(1)">', "Science", "BBC")])).toEqual([
      '<img src=x onerror="alert(1)">',
    ]);
  });

  it("caps every title it returns", () => {
    const out = sampleWireTitles([article("word ".repeat(400), "Science", "BBC")]);
    expect(out[0].length).toBeLessThanOrEqual(WIRE_TITLE_MAX_CHARS);
  });
});
