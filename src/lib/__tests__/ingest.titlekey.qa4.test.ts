import { describe, it, expect } from "vitest";
import { dedupeArticles, normalizeTitle } from "@/lib/ingest";
import { SOURCES, TOPICS, type Article, type Source, type Topic } from "@/types";

// QA round 4: normalizeTitle now keeps \p{M}. That class also holds emoji
// variation selectors (U+FE0F, Mn) and the keycap mark (U+20E3, Me), which
// are presentation, not letters. Never names a topic or an outlet.
// Code points are built with fromCodePoint so no invisible character sits in
// this file's source.

const TOPIC = TOPICS[0] as Topic;
const [OUTLET] = SOURCES as readonly Source[];
const cp = (n: number) => String.fromCodePoint(n);
const VS16 = cp(0xfe0f);
const KEYCAP = cp(0x20e3);
const SOCCER = cp(0x26bd);
const HEART = cp(0x2764);
const ACUTE = cp(0x0301);
const E_ACUTE = cp(0x00e9);
const DIAERESIS = cp(0x0308);
const EM_DASH = cp(0x2014);

function article(url: string, title: string): Article {
  return { title, snippet: "", url, source: OUTLET, topic: TOPIC, publishedAt: "2026-10-02T12:00:00Z" };
}

describe("combining marks that carry meaning", () => {
  it("a decomposed accent and its precomposed letter still key alike (NFKC runs first)", () => {
    expect(normalizeTitle(`Re${ACUTE}sultats`)).toBe(normalizeTitle(`R${E_ACUTE}sultats`));
  });

  it("a mark with no precomposed letter is kept: two words differing only by it stay apart", () => {
    // n + U+0308 has no single-code-point form, so NFKC leaves the mark separate;
    // at a word end, dropping it would make the two headlines identical.
    expect(normalizeTitle(`Spin${DIAERESIS} Tap`)).not.toBe(normalizeTitle("Spin Tap"));
  });
});

describe("marks that are only emoji presentation", () => {
  it("a headline with no letters or digits has no key, even when its emoji carry a variation selector", () => {
    expect(normalizeTitle(`${SOCCER}${VS16}`)).toBeNull();
    expect(normalizeTitle(`${HEART}${VS16} ${EM_DASH} !`)).toBeNull();
  });

  it("two different emoji-only headlines from one outlet are two articles", () => {
    const out = dedupeArticles([
      article("https://ex.test/a", `${SOCCER}${VS16}`),
      article("https://ex.test/b", `${HEART}${VS16}`),
    ]);
    expect(out).toHaveLength(2);
  });

  it("an emoji's text and emoji presentation do not make two headlines differ", () => {
    expect(normalizeTitle(`Breaking ${HEART}${VS16} news`)).toBe(normalizeTitle(`Breaking ${HEART} news`));
  });

  it("a keycap number keys as its number", () => {
    expect(normalizeTitle(`Top 3${VS16}${KEYCAP} picks`)).toBe(normalizeTitle("Top 3 picks"));
  });
});
