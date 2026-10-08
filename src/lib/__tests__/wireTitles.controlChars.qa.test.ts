import { describe, it, expect } from "vitest";
import { cleanWireTitle, sampleWireTitles, WIRE_TITLE_MAX_CHARS } from "@/lib/wireTitles";
import type { Article } from "@/types";

// Control characters in fetched titles (U+0000-U+001F, U+007F) collapse
// like whitespace, so no C0 control or DEL ever reaches the loaders.

const C0_AND_DEL = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f].map((c) => String.fromCharCode(c));
const hex = (ch: string) => `U+${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;

function article(title: string, i: number): Article {
  return {
    title,
    url: `https://example.test/${i}`,
    source: `Outlet ${i % 3}`,
    topic: "Science",
    subtopic: null,
    publishedAt: "2026-10-08T06:00:00Z",
    snippet: "",
  } as unknown as Article;
}

describe("cleanWireTitle with control characters", () => {
  for (const ch of C0_AND_DEL) {
    it(`${hex(ch)} between words becomes one space`, () => {
      expect(cleanWireTitle(`Left${ch}Right`)).toBe("Left Right");
    });
  }

  it("a run mixing controls and whitespace collapses to a single space", () => {
    expect(cleanWireTitle("A \u0000\t\u0001\n \u007f  B")).toBe("A B");
  });

  it("leading and trailing controls are trimmed", () => {
    expect(cleanWireTitle("\u0000\u0007 Headline \u001f\u007f")).toBe("Headline");
  });

  it("a title of only controls is empty", () => {
    expect(cleanWireTitle(C0_AND_DEL.join(""))).toBe("");
  });

  it("no output ever contains a C0 control or DEL", () => {
    const raw = C0_AND_DEL.map((c, i) => `w${i}${c}`).join("");
    expect(cleanWireTitle(raw)).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("printable neighbours of the range survive: space (U+0020), tilde (U+007E), and U+00A0 is whitespace", () => {
    expect(cleanWireTitle("a ~ b")).toBe("a ~ b");
    expect(cleanWireTitle("a b")).toBe("a b");
  });

  it("the length cap is measured after controls collapse", () => {
    const body = "x".repeat(WIRE_TITLE_MAX_CHARS - 2);
    expect(cleanWireTitle(`${"\u0000".repeat(50)}${body}${"\u0000".repeat(50)}`)).toBe(body);
  });

  it("a long title cut at a word boundary where the boundary was a NUL", () => {
    const word = "word";
    const raw = Array.from({ length: 60 }, () => word).join("\u0000");
    const out = cleanWireTitle(raw);
    expect(out.length).toBeLessThanOrEqual(WIRE_TITLE_MAX_CHARS);
    expect(out.endsWith("word…")).toBe(true);
    expect(out).not.toContain("\u0000");
  });
});

describe("sampleWireTitles with control characters", () => {
  it("drops control-only titles and dedups a title against its control-laced twin", () => {
    const picked = sampleWireTitles([
      article("\u0000\u0001\u0002", 0),
      article("Rates held\u0000steady", 1),
      article("rates HELD steady", 2),
      article("Storm\u0007 warning", 3),
    ]);
    expect(picked).toEqual(["Rates held steady", "Storm warning"]);
  });
});
