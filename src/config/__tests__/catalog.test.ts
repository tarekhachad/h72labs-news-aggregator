import { describe, it, expect } from "vitest";
import { FEEDS } from "@/config/feeds";
import { SOURCES, TOPICS } from "@/types";

// The catalog's shape rules. Whether each feed is live is a network question,
// answered by scripts/verify-feeds.mts; these hold the rules that need no
// network, so a hand edit to FEEDS cannot quietly break them.

const MIN_FEEDS_PER_TOPIC = 3;

describe("topic and source catalog", () => {
  it("gives every shipped topic at least 3 feeds", () => {
    const thin = TOPICS.filter(
      (topic) => Object.keys(FEEDS[topic] ?? {}).length < MIN_FEEDS_PER_TOPIC
    );
    expect(thin).toEqual([]);
  });

  it("uses every shipped source in at least one feed", () => {
    const used = new Set(Object.values(FEEDS).flatMap((bySource) => Object.keys(bySource)));
    const unused = SOURCES.filter((source) => !used.has(source));
    expect(unused).toEqual([]);
  });

  // The Record<Topic, …> type stops a topic from missing, but a key spelled
  // outside the union only fails the type check where the object is a literal,
  // and FEEDS is read by key at runtime.
  it("has a feed list for exactly the shipped topics", () => {
    expect(Object.keys(FEEDS).sort()).toEqual([...TOPICS].sort());
  });

  it("files feeds only under shipped sources", () => {
    const known = new Set<string>(SOURCES);
    const stray = Object.entries(FEEDS).flatMap(([topic, bySource]) =>
      Object.keys(bySource)
        .filter((source) => !known.has(source))
        .map((source) => `${topic} / ${source}`)
    );
    expect(stray).toEqual([]);
  });

  it("lists each topic and each source once", () => {
    expect(new Set(TOPICS).size).toBe(TOPICS.length);
    expect(new Set(SOURCES).size).toBe(SOURCES.length);
  });

  it("points every feed at an absolute http(s) URL", () => {
    const bad = Object.entries(FEEDS).flatMap(([topic, bySource]) =>
      Object.entries(bySource)
        .filter(([, url]) => {
          try {
            return !["http:", "https:"].includes(new URL(url as string).protocol);
          } catch {
            return true;
          }
        })
        .map(([source]) => `${topic} / ${source}`)
    );
    expect(bad).toEqual([]);
  });

  // A digest fills a topic's slots in FEEDS key order. JavaScript reorders
  // integer-like keys ahead of all others, so a source named like "90" would
  // silently jump to the front of every topic it is in.
  it("has no source name that JavaScript would reorder as an integer key", () => {
    expect(SOURCES.filter((source) => /^\d+$/.test(source))).toEqual([]);
  });

  it("offers Football in place of European Football", () => {
    expect(TOPICS).toContain("Football");
    expect(TOPICS as readonly string[]).not.toContain("European Football");
  });
});
