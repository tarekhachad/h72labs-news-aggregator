import { describe, it, expect } from "vitest";
import { dedupeArticles, normalizeTitle } from "@/lib/ingest";
import { SOURCES, TOPICS, type Article, type Source, type Topic } from "@/types";

// QA round 5: the same-outlet headline key. Emoji presentation never makes or
// breaks a key; a headline with no letter or digit has none; marks that are
// part of a word stay. Never names a topic or an outlet. Code points are built
// with fromCodePoint so no invisible character sits in this file's source.

const TOPIC = TOPICS[0] as Topic;
const [OUTLET, OTHER_OUTLET] = SOURCES as readonly Source[];
const cp = (...n: number[]) => String.fromCodePoint(...n);

const VS16 = cp(0xfe0f);
const VS15 = cp(0xfe0e);
const ZWJ = cp(0x200d);
const KEYCAP = cp(0x20e3);
const ACUTE = cp(0x0301);
const MAN = cp(0x1f468);
const WOMAN = cp(0x1f469);
const GIRL = cp(0x1f467);
const HEART = cp(0x2764);
const SOCCER = cp(0x26bd);
const FAMILY = [MAN, WOMAN, GIRL].join(ZWJ);
const COUPLE = `${MAN}${ZWJ}${HEART}${VS16}${ZWJ}${MAN}`;
const THUMBS_TONE = cp(0x1f44d, 0x1f3fd);
const FLAG_PAIR = cp(0x1f1f2, 0x1f1e6);
const FLAG_TAGS = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
const IDEOGRAPH_VS = cp(0xe0100);

let n = 0;
function article(title: string, source: Source = OUTLET): Article {
  n += 1;
  return { title, snippet: "", url: `https://ex.test/${n}`, source, topic: TOPIC, publishedAt: "2026-10-02T12:00:00Z" };
}

describe("headlines with no letter or digit have no key", () => {
  it.each([
    ["a lone combining mark", ACUTE],
    ["a combining mark sitting on an emoji", `${SOCCER}${ACUTE}`],
    ["a mark after an emoji's variation selector", `${HEART}${VS16}${ACUTE}`],
    ["a ZWJ family sequence", FAMILY],
    ["a ZWJ sequence holding a variation selector", COUPLE],
    ["an emoji with a skin-tone modifier", THUMBS_TONE],
    ["a regional-indicator flag", FLAG_PAIR],
    ["a tag-sequence flag", FLAG_TAGS],
    ["a hash keycap", `#${VS16}${KEYCAP}`],
    ["an asterisk keycap", `*${VS16}${KEYCAP}`],
    ["a text-presentation selector on a symbol", `${HEART}${VS15}`],
    ["whitespace only", "  　 "],
  ])("%s", (_label, title) => {
    expect(normalizeTitle(title)).toBeNull();
  });

  it("two different ZWJ-only headlines from one outlet are two articles", () => {
    expect(dedupeArticles([article(FAMILY), article(COUPLE), article(FLAG_TAGS)])).toHaveLength(3);
  });

  it("the same emoji-only headline twice from one outlet under two links is two articles", () => {
    expect(dedupeArticles([article(COUPLE), article(COUPLE)])).toHaveLength(2);
  });
});

describe("emoji presentation does not change a key that has letters", () => {
  it("a ZWJ sequence with a variation selector inside keys like the words alone", () => {
    expect(normalizeTitle(`Win ${COUPLE}`)).toBe(normalizeTitle("Win"));
  });

  it("text and emoji presentation selectors key alike", () => {
    expect(normalizeTitle(`Alert ${HEART}${VS15} now`)).toBe(normalizeTitle(`Alert ${HEART}${VS16} now`));
  });

  it("an ideographic variation selector does not split or change a word", () => {
    const word = cp(0x845b, 0x98fe);
    expect(normalizeTitle(`${cp(0x845b)}${IDEOGRAPH_VS}${cp(0x98fe)}`)).toBe(normalizeTitle(word));
  });

  it("one outlet's headline with and without a trailing ZWJ emoji is one article", () => {
    const out = dedupeArticles([article("Final score is in"), article(`Final score is in ${FAMILY}`)]);
    expect(out).toHaveLength(1);
  });

  it("the same pair from two outlets stays two sources", () => {
    const out = dedupeArticles([
      article("Final score is in"),
      article(`Final score is in ${FAMILY}`, OTHER_OUTLET),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("numbers", () => {
  it("a headline that is only a number has a key", () => {
    expect(normalizeTitle("2026")).toBe("2026");
  });

  it("a keycap digit alone keys as its digit", () => {
    expect(normalizeTitle(`7${VS16}${KEYCAP}`)).toBe("7");
  });

  it("different numbers stay apart", () => {
    expect(normalizeTitle("Top 10 moments")).not.toBe(normalizeTitle("Top 1 moments"));
    expect(dedupeArticles([article("Top 10 moments"), article("Top 1 moments")])).toHaveLength(2);
  });

  it("full-width digits key as their ASCII digits (NFKC)", () => {
    expect(normalizeTitle(`Top ${cp(0xff11, 0xff10)}`)).toBe(normalizeTitle("Top 10"));
  });

  it("a keycap digit before a word stays its own token", () => {
    expect(normalizeTitle(`1${VS16}${KEYCAP} reason`)).toBe(normalizeTitle("1 reason"));
    expect(normalizeTitle(`1${VS16}${KEYCAP} reason`)).not.toBe(normalizeTitle("1reason"));
  });
});

describe("marks that belong to the word, and mixed scripts", () => {
  it("Devanagari words differing only by a word-final vowel sign stay apart", () => {
    // ka + vowel sign aa vs ka: dropping the sign would make them one key.
    expect(normalizeTitle(`news ${cp(0x0915, 0x093e)}`)).not.toBe(normalizeTitle(`news ${cp(0x0915)}`));
  });

  it("Thai with and without a vowel mark stay apart, and both have keys", () => {
    const withMark = normalizeTitle(`news ${cp(0x0e01, 0x0e34)}`);
    const without = normalizeTitle(`news ${cp(0x0e01)}`);
    expect(withMark).not.toBeNull();
    expect(without).not.toBeNull();
    expect(withMark).not.toBe(without);
  });

  it("a lone vowel sign with no base letter has no key", () => {
    expect(normalizeTitle(cp(0x093e))).toBeNull();
  });

  it("a Latin word and its Cyrillic look-alike are two different keys", () => {
    // Second word swaps Latin a for Cyrillic a (U+0430).
    expect(normalizeTitle("Paris")).not.toBe(normalizeTitle(`P${cp(0x0430)}ris`));
  });

  it("a headline mixing scripts keeps every script's letters", () => {
    const key = normalizeTitle(`Rabat ${cp(0x0627, 0x0644, 0x0631, 0x0628, 0x0627, 0x0637)} 2026`);
    expect(key).toBe(`rabat ${cp(0x0627, 0x0644, 0x0631, 0x0628, 0x0627, 0x0637)} 2026`);
  });

  it("an emoji between two words still separates them", () => {
    expect(normalizeTitle(`goal${SOCCER}${VS16}keeper`)).toBe("goal keeper");
    expect(normalizeTitle(`goal${SOCCER}${VS16}keeper`)).not.toBe(normalizeTitle("goalkeeper"));
  });
});
