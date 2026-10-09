import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { TOPICS } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { TOPIC_GROUPS } from "@/config/topicGroups";
import { TOPIC_DESCRIPTIONS, TOPIC_SEARCH_TERMS } from "@/config/topicDescriptions";

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

  // A chip's description line is about 190 px of 12 px Source Serif 4 at
  // laptop widths, where the page's max-w-6xl caps the grid at five 216 px
  // chips. Measured on the fixture page, the widest of these lines is 180 px
  // and the longest is 33 characters; much past that, lines start to wrap.
  it("keeps each line short enough to fit one line of its chip", () => {
    const long = Object.entries(TOPIC_DESCRIPTIONS).filter(([, line]) => line.length > 33);
    expect(long).toEqual([]);
  });
});

describe("topic search terms", () => {
  it("gives every pickable topic one non-empty line of search text, and no other key", () => {
    expect(Object.keys(TOPIC_SEARCH_TERMS).sort()).toEqual([...PICKABLE].sort());
    for (const topic of PICKABLE) {
      const line = TOPIC_SEARCH_TERMS[topic as keyof typeof TOPIC_SEARCH_TERMS];
      expect(line.trim(), topic).not.toBe("");
      expect(line, topic).not.toContain("\n");
    }
  });

  // Words a reader would type that the one-line descriptions had no room for.
  // Each must still be found in the topic's searchable text: its name, its
  // line and its search terms, folded the way a search box compares them.
  const fold = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const searchable = (topic: keyof typeof TOPIC_SEARCH_TERMS) =>
    fold(`${topic} ${TOPIC_DESCRIPTIONS[topic]} ${TOPIC_SEARCH_TERMS[topic]}`);
  it.each([
    ["climate change", "Climate & Environment"],
    ["electric", "Energy Transition & Renewables"],
    ["hospital", "Health & Medicine"],
    ["clinical trials", "Biotech & Pharma"],
    ["video games", "Gaming"],
    ["washington", "US Politics"],
    ["parliament", "Morocco Politics"],
    ["parliament", "French Politics"],
    ["parliament", "UK Politics"],
    ["southeast asia", "Asia-Pacific"],
    ["south africa", "Africa"],
    ["defence", "Defense & Security"],
    ["casablanca", "Morocco Finance"],
    ["interest rates", "Economy"],
    ["mortgage", "Personal Finance"],
    ["mortgage", "Real Estate"],
    ["transfers", "Football"],
    ["grand prix", "Formula 1"],
    ["hollywood", "Film & TV"],
    ["wildfire", "Weather & Natural Disasters"],
    ["earthquake", "Weather & Natural Disasters"],
  ] as const)("finds %s under %s", (query, topic) => {
    for (const term of fold(query).split(/\s+/)) expect(searchable(topic)).toContain(term);
  });
});
