import { describe, it, expect } from "vitest";
import type { Article, Source, Topic } from "@/types";
import { cleanWireTitle, sampleWireTitles, WIRE_TITLE_LIMIT, WIRE_TITLE_MAX_CHARS } from "@/lib/wireTitles";

// The sampler's spread, dedup and cap rules at their edges.

function article(
  title: string,
  topic: string,
  source: string,
  subtopic: string | null | undefined = null
): Article {
  return {
    title,
    snippet: "",
    url: `https://example.com/${encodeURIComponent(title)}`,
    source: source as Source,
    topic: topic as Topic,
    subtopic: subtopic as string | null,
    publishedAt: "2026-10-08T07:00:00Z",
  };
}

describe("sampleWireTitles, QA edges", () => {
  it("with more units than the limit, takes the first title of each of the first `limit` units, in arrival order", () => {
    const articles: Article[] = [];
    for (let u = 0; u < 25; u++) {
      articles.push(article(`U${u} a`, `T${u}`, "BBC"), article(`U${u} b`, `T${u}`, "BBC"));
    }
    const out = sampleWireTitles(articles);
    expect(out).toHaveLength(WIRE_TITLE_LIMIT);
    expect(out).toEqual(Array.from({ length: 20 }, (_, u) => `U${u} a`));
  });

  it("orders units by first arrival even when their articles are interleaved", () => {
    const out = sampleWireTitles([
      article("A1", "A", "BBC"),
      article("B1", "B", "BBC"),
      article("A2", "A", "BBC"),
      article("C1", "C", "BBC"),
      article("B2", "B", "BBC"),
    ]);
    expect(out).toEqual(["A1", "B1", "C1", "A2", "B2"]);
  });

  it("round-robins three outlets within one unit, by each outlet's first arrival", () => {
    const out = sampleWireTitles([
      article("X1", "Science", "X"),
      article("X2", "Science", "X"),
      article("X3", "Science", "X"),
      article("Y1", "Science", "Y"),
      article("Z1", "Science", "Z"),
      article("Y2", "Science", "Y"),
    ]);
    expect(out).toEqual(["X1", "Y1", "Z1", "X2", "Y2", "X3"]);
  });

  it("same topic, different subtopic are separate units; null and undefined subtopic are the same unit", () => {
    const out = sampleWireTitles(
      [
        article("N1", "Countries", "BBC", null),
        article("N2", "Countries", "BBC", undefined),
        article("K1", "Countries", "BBC", "Kenya"),
      ],
      2
    );
    expect(out).toEqual(["N1", "K1"]);
  });

  it("dedups titles that only match after whitespace collapse and case, across units and outlets", () => {
    const out = sampleWireTitles([
      article("Storm\nhits   coast", "Science", "BBC"),
      article("STORM HITS COAST", "Football", "NYT"),
      article("  storm hits coast  ", "Countries", "AP", "Kenya"),
      article("Unique", "Football", "NYT"),
    ]);
    expect(out).toEqual(["Storm hits coast", "Unique"]);
  });

  it("a duplicate in one unit's turn does not let that unit skip its round: it takes its next title", () => {
    const out = sampleWireTitles([
      article("Shared", "A", "BBC"),
      article("Shared", "B", "BBC"),
      article("B second", "B", "BBC"),
      article("A second", "A", "BBC"),
    ]);
    expect(out).toEqual(["Shared", "B second", "A second"]);
  });

  it("stops when every unit is exhausted, below the limit, without looping forever", () => {
    const out = sampleWireTitles([article("Only", "A", "BBC"), article("only", "A", "NYT"), article(" ", "B", "AP")]);
    expect(out).toEqual(["Only"]);
  });

  it("a limit of 0 gives nothing", () => {
    expect(sampleWireTitles([article("A", "A", "BBC")], 0)).toEqual([]);
  });

  it("every returned title is non-empty, trimmed, single-spaced, unique by case, and within the cap", () => {
    const articles: Article[] = [];
    for (let i = 0; i < 300; i++) {
      const pad = " \t\n".repeat(i % 4);
      articles.push(article(`${pad}Title ${i % 37}${pad}${"word ".repeat(i % 60)}`, `T${i % 7}`, `S${i % 5}`));
    }
    const out = sampleWireTitles(articles);
    expect(out.length).toBeLessThanOrEqual(WIRE_TITLE_LIMIT);
    expect(new Set(out.map((t) => t.toLowerCase())).size).toBe(out.length);
    for (const t of out) {
      expect(t).not.toBe("");
      expect(t).toBe(t.trim());
      expect(t).not.toMatch(/\s{2,}|[\t\n]/);
      expect(t.length).toBeLessThanOrEqual(WIRE_TITLE_MAX_CHARS);
    }
  });

  it("handles a large, hostile batch quickly (5,000 articles with 48k-character titles)", () => {
    const huge = "a ".repeat(24_000);
    const articles = Array.from({ length: 5_000 }, (_, i) => article(`${i} ${huge}`, `T${i % 20}`, `S${i % 30}`));
    const t0 = performance.now();
    const out = sampleWireTitles(articles);
    const ms = performance.now() - t0;
    expect(out).toHaveLength(20);
    expect(ms).toBeLessThan(1_000);
  });
});

describe("cleanWireTitle, QA edges", () => {
  it("at cap+1 characters it cuts and the result, ellipsis included, is within the cap", () => {
    const words = `${"abcd ".repeat(28)}x`; // 141 chars
    expect(words.length).toBe(WIRE_TITLE_MAX_CHARS + 1);
    const out = cleanWireTitle(words);
    expect(out.length).toBeLessThanOrEqual(WIRE_TITLE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/ …$/);
  });

  it("measures length after collapsing whitespace, so a short title padded with spaces is not cut", () => {
    const padded = `Short${" ".repeat(300)}title`;
    expect(cleanWireTitle(padded)).toBe("Short title");
  });

  it("collapses non-breaking and other Unicode spaces as whitespace", () => {
    expect(cleanWireTitle("A  B C")).toBe("A B C");
  });
});
