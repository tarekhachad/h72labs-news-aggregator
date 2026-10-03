import { describe, expect, it } from "vitest";
import {
  DAILY_CARDS_PER_TOPIC_CEILING,
  FIRST_RUN_CARDS_PER_TOPIC,
  TOP_UP_CARDS_PER_TOPIC,
  applyCardCap,
} from "@/lib/cardCap";
import { TOPICS, type Cluster, type Topic } from "@/types";

const C = "Countries" as Topic;
const A = TOPICS[0] as Topic;
const B = TOPICS[1] as Topic;

function item(label: string, topic: Topic, subtopic?: string | null, severity = 3) {
  const cluster: Cluster = {
    topic,
    ...(subtopic === undefined ? {} : { subtopic }),
    articles: [{ title: label, snippet: "", url: `https://e.com/${label}`, source: "BBC", topic, publishedAt: "2026-10-03T12:00:00Z" }],
  };
  return { label, cluster, severity };
}
const many = (p: string, topic: Topic, sub: string | null | undefined, n: number, sev = 3) =>
  Array.from({ length: n }, (_, i) => item(`${p}${i}`, topic, sub, sev));

describe("QA: cardCap keying edge cases", () => {
  it("a subtopic of the literal string 'null' is its own unit, not the plain one", () => {
    const notable = [...many("n", C, null, 10), ...many("s", C, "null", 10)];
    const { kept } = applyCardCap(notable, { runShape: "firstOfDay", existingCards: [] });
    expect(kept.filter((k) => k.cluster.subtopic === null)).toHaveLength(FIRST_RUN_CARDS_PER_TOPIC);
    expect(kept.filter((k) => k.cluster.subtopic === "null")).toHaveLength(FIRST_RUN_CARDS_PER_TOPIC);
  });

  it("the same subtopic name under two different topics is two units", () => {
    const notable = [...many("a", A, "X", 10), ...many("b", B, "X", 10)];
    const { kept, cuts } = applyCardCap(notable, { runShape: "firstOfDay", existingCards: [] });
    expect(kept).toHaveLength(2 * FIRST_RUN_CARDS_PER_TOPIC);
    expect(cuts.map((c) => [c.topic, c.subtopic])).toEqual([[A, "X"], [B, "X"]]);
  });

  it("existing cards with subtopic undefined count against the plain unit (old rows)", () => {
    const existing = Array.from({ length: DAILY_CARDS_PER_TOPIC_CEILING }, () => ({ topic: A }));
    const { kept } = applyCardCap(many("a", A, undefined, 5), { runShape: "sameDayTopUp", existingCards: existing });
    expect(kept).toHaveLength(0);
  });

  it("existing Countries cards with no subtopic do NOT eat a country's ceiling", () => {
    const existing = Array.from({ length: DAILY_CARDS_PER_TOPIC_CEILING }, () => ({ topic: C, subtopic: null }));
    const { kept } = applyCardCap(many("u", C, "Uganda", 5), { runShape: "sameDayTopUp", existingCards: existing });
    expect(kept).toHaveLength(TOP_UP_CARDS_PER_TOPIC);
  });

  it("a failed existing-cards lookup (null) skips the ceiling for every country", () => {
    const notable = [...many("u", C, "Uganda", 10), ...many("k", C, "Kenya", 10)];
    const { kept } = applyCardCap(notable, { runShape: "sameDayTopUp", existingCards: null });
    expect(kept).toHaveLength(2 * TOP_UP_CARDS_PER_TOPIC);
  });

  it("kept preserves input order across interleaved countries", () => {
    const notable = [item("u0", C, "Uganda"), item("k0", C, "Kenya"), item("p0", A, null), item("u1", C, "Uganda")];
    const { kept } = applyCardCap(notable, { runShape: "firstOfDay", existingCards: [] });
    expect(kept.map((k) => k.label)).toEqual(["u0", "k0", "p0", "u1"]);
  });

  it("zero-country invariant: plain-only input keeps the same items whether subtopic is absent or null", () => {
    const sevs = [5, 1, 4, 2, 3, 5, 1, 4, 2, 3, 5, 2];
    const mk = (sub: null | undefined) => [
      ...sevs.map((s, i) => item(`a${i}`, A, sub, s)),
      ...sevs.map((s, i) => item(`b${i}`, B, sub, s)),
    ];
    const withAbsent = applyCardCap(mk(undefined), { runShape: "firstOfDay", existingCards: [{ topic: A }] });
    const withNull = applyCardCap(mk(null), { runShape: "firstOfDay", existingCards: [{ topic: A, subtopic: null }] });
    expect(withAbsent.kept.map((k) => k.label)).toEqual(withNull.kept.map((k) => k.label));
    expect(withAbsent.cuts).toEqual(withNull.cuts);
    expect(withAbsent.cuts.every((c) => c.subtopic === null)).toBe(true);
  });
});
