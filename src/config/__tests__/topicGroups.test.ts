import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { TOPICS } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { TOPIC_GROUPS } from "@/config/topicGroups";
import { TOPIC_DESCRIPTIONS } from "@/config/topicDescriptions";
import { STARTER_SETS } from "@/config/starterSets";
import { MAX_READING_UNITS, MIN_READING_UNITS } from "@/lib/readingUnits";

const PICKABLE = TOPICS.filter((topic) => topic !== COUNTRIES_TOPIC);

/** The catalog doc's "Topics and their feeds": each `### group` and the `**Topic**` headings under it. */
function catalogGroups(): { name: string; topics: string[] }[] {
  const doc = readFileSync(resolve(__dirname, "../../../docs/(C) SOURCE_CATALOG.md"), "utf8");
  const start = doc.indexOf("## Topics and their feeds");
  const end = doc.indexOf("\n## ", start + 1);
  expect(start).toBeGreaterThan(-1);
  const groups: { name: string; topics: string[] }[] = [];
  for (const line of doc.slice(start, end === -1 ? undefined : end).split("\n")) {
    const group = line.match(/^### (.+)$/);
    if (group) groups.push({ name: group[1].trim(), topics: [] });
    const topic = line.match(/^\*\*(.+?)\*\* \(\d+ feeds?\)/);
    if (topic) groups.at(-1)!.topics.push(topic[1]);
  }
  return groups;
}

describe("topic groups", () => {
  it("puts every pickable topic in exactly one group, and nothing else", () => {
    const grouped = TOPIC_GROUPS.flatMap((group) => group.topics);
    expect([...grouped].sort()).toEqual([...PICKABLE].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("never offers Countries as a topic", () => {
    expect(TOPIC_GROUPS.flatMap((group) => group.topics)).not.toContain(COUNTRIES_TOPIC);
  });

  it("matches the catalog's six groups, their names, order and members", () => {
    const catalog = catalogGroups();
    expect(catalog.map((g) => g.name)).toEqual([
      "Technology and science",
      "Politics and world",
      "Business and economy",
      "Sports",
      "Culture and life",
      "Society",
    ]);
    expect(TOPIC_GROUPS.map((g) => ({ name: g.name, topics: [...g.topics].sort() }))).toEqual(
      catalog.map((g) => ({ name: g.name, topics: [...g.topics].sort() }))
    );
  });
});

describe("topic descriptions", () => {
  it("gives every pickable topic exactly one non-empty line, and no other key", () => {
    expect(Object.keys(TOPIC_DESCRIPTIONS).sort()).toEqual([...PICKABLE].sort());
    for (const topic of PICKABLE) {
      const line = TOPIC_DESCRIPTIONS[topic as keyof typeof TOPIC_DESCRIPTIONS];
      expect(typeof line, topic).toBe("string");
      expect(line.trim(), topic).not.toBe("");
      expect(line, topic).not.toContain("\n");
    }
  });

  it("keeps each line short enough for a chip's second line", () => {
    const long = Object.entries(TOPIC_DESCRIPTIONS).filter(([, line]) => line.length > 80);
    expect(long).toEqual([]);
  });
});

describe("starter sets", () => {
  it("has the four drafted sets", () => {
    expect(STARTER_SETS.map((set) => set.name)).toEqual([
      "Morocco watcher",
      "World and geopolitics",
      "Tech and markets",
      "Sport",
    ]);
  });

  it("uses only real pickable topics, each once, within the limits", () => {
    for (const set of STARTER_SETS) {
      for (const topic of set.topics) expect(PICKABLE, `${set.name}: ${topic}`).toContain(topic);
      expect(new Set(set.topics).size, set.name).toBe(set.topics.length);
      expect(set.topics.length, set.name).toBeGreaterThanOrEqual(Math.max(MIN_READING_UNITS, 5));
      expect(set.topics.length, set.name).toBeLessThanOrEqual(Math.min(MAX_READING_UNITS, 6));
    }
  });
});
