import { describe, it, expect } from "vitest";
import { SOURCES, type Source, type Topic } from "@/types";
import { FEEDS } from "@/config/feeds";
import { COUNTRY_FEEDS } from "@/config/countries";
import {
  buildSourceCoverage,
  coverageDetail,
  coverageSentence,
  coveredPicks,
  groupSourcesByCoverage,
} from "@/lib/sourceCoverage";

// A small made-up catalog, so the grouping rules are tested apart from
// whichever feeds the real catalog happens to list today.
const TOPIC_FEEDS: Partial<Record<Topic, Partial<Record<Source, string>>>> = {
  "Tech/AI": { BBC: "https://a.example/1", TechCrunch: "https://a.example/2", "The Verge": "https://a.example/3" },
  Football: { BBC: "https://a.example/4", Kicker: "https://a.example/5" },
  Cybersecurity: { BBC: "https://a.example/6", TechCrunch: "https://a.example/7" },
  Countries: {},
};
const COUNTRY_FEEDS_FIXTURE: Record<string, Partial<Record<Source, string>>> = {
  Morocco: { "Hespress (EN)": "https://b.example/1", "The Guardian": "https://b.example/2" },
  France: { "Le Monde": "https://b.example/3", "The Guardian": "https://b.example/4" },
  Kenya: { "Nation (Kenya)": "https://b.example/5" },
};
const coverage = buildSourceCoverage(TOPIC_FEEDS, COUNTRY_FEEDS_FIXTURE);

const group = (groups: ReturnType<typeof groupSourcesByCoverage>, label: string) =>
  groups.find((g) => g.label === label);

describe("buildSourceCoverage", () => {
  it("lists each outlet's topics and countries, names only", () => {
    expect(coverage.BBC).toEqual({ topics: ["Tech/AI", "Football", "Cybersecurity"], countries: [] });
    expect(coverage["The Guardian"]).toEqual({ topics: [], countries: ["France", "Morocco"] });
    expect(coverage.Kicker.topics).toEqual(["Football"]);
  });

  it("has an entry for every offered outlet, even one with no feed here", () => {
    expect(Object.keys(coverage).sort()).toEqual([...SOURCES].sort());
    expect(coverage.NYT).toEqual({ topics: [], countries: [] });
  });

  it("never lists Countries as a topic", () => {
    for (const own of Object.values(coverage)) expect(own.topics).not.toContain("Countries");
  });

  it("carries no feed URL, built from the real catalog", () => {
    const real = buildSourceCoverage(FEEDS, COUNTRY_FEEDS);
    const json = JSON.stringify(real);
    expect(json).not.toMatch(/https?:/i);
    expect(json).not.toMatch(/\/\//);
    // And it does carry the real coverage.
    expect(real.BBC.topics).toContain("Tech/AI");
    expect(Object.values(real).some((own) => own.countries.length > 0)).toBe(true);
  });
});

describe("coveredPicks", () => {
  it("keeps only the reader's picks", () => {
    expect(coveredPicks(coverage, "BBC", ["Football", "Gaming"], [])).toEqual({ topics: ["Football"], countries: [] });
    expect(coveredPicks(coverage, "The Guardian", ["Football"], ["Morocco", "Kenya"])).toEqual({
      topics: [],
      countries: ["Morocco"],
    });
  });
});

describe("groupSourcesByCoverage", () => {
  const topics: Topic[] = ["Tech/AI", "Cybersecurity", "Football"];

  it("puts outlets covering the reader's topics first, most topics first", () => {
    const groups = groupSourcesByCoverage(coverage, topics, []);
    expect(groups[0].label).toBe("Covers your topics");
    expect(groups[0].items).toEqual(["BBC", "TechCrunch", "Kicker", "The Verge"]);
  });

  it("then outlets covering the reader's countries", () => {
    const groups = groupSourcesByCoverage(coverage, topics, ["Morocco"]);
    expect(group(groups, "Covers your countries")?.items).toEqual(["Hespress (EN)", "The Guardian"]);
  });

  it("files everything else under its one country, or International", () => {
    const groups = groupSourcesByCoverage(coverage, topics, ["Morocco"]);
    expect(group(groups, "France")?.items).toEqual(["Le Monde"]);
    expect(group(groups, "France")?.section).toBe("Everything else");
    expect(group(groups, "Kenya")?.items).toEqual(["Nation (Kenya)"]);
    const international = group(groups, "International");
    expect(international?.section).toBe("Everything else");
    expect(international?.items).toContain("NYT");
    // Morocco's outlets cover a pick, so it has no group of its own.
    expect(group(groups, "Morocco")).toBeUndefined();
  });

  it("puts an outlet with feeds for several countries under International when it covers none of them", () => {
    const groups = groupSourcesByCoverage(coverage, topics, []);
    expect(group(groups, "International")?.items).toContain("The Guardian");
  });

  it("places every outlet exactly once, whatever the picks", () => {
    for (const [t, c] of [
      [[], []],
      [topics, []],
      [topics, ["Morocco", "France"]],
      [["Gaming"], ["Kenya"]],
    ] as [Topic[], string[]][]) {
      const all = groupSourcesByCoverage(coverage, t, c).flatMap((g) => g.items);
      expect([...all].sort()).toEqual([...SOURCES].sort());
    }
  });

  it("leaves out the coverage groups while nothing is picked", () => {
    const groups = groupSourcesByCoverage(coverage, [], []);
    expect(groups.map((g) => g.label)).not.toContain("Covers your topics");
    expect(groups.map((g) => g.label)).not.toContain("Covers your countries");
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
  });

  it("moves an outlet between groups as the picks change", () => {
    expect(group(groupSourcesByCoverage(coverage, ["Gaming"], []), "Covers your topics")).toBeUndefined();
    expect(group(groupSourcesByCoverage(coverage, ["Football"], []), "Covers your topics")?.items).toEqual([
      "BBC",
      "Kicker",
    ]);
  });
});

describe("coverage words", () => {
  it("says how many of the reader's topics and countries an outlet covers", () => {
    expect(coverageSentence(coverage, "BBC", ["Tech/AI", "Football"], [])).toBe("BBC covers 2 of your topics");
    expect(coverageSentence(coverage, "The Guardian", ["Tech/AI"], ["France"])).toBe(
      "The Guardian covers 1 of your countries"
    );
    expect(coverageSentence(coverage, "Kicker", ["Tech/AI"], [])).toBe("Kicker covers none");
    const both = buildSourceCoverage({ "Tech/AI": { BBC: "x" } }, { France: { BBC: "y" } });
    expect(coverageSentence(both, "BBC", ["Tech/AI"], ["France"])).toBe("BBC covers 1 of your topics and 1 of your countries");
  });

  it("gives the picker a count for topics and the names for countries", () => {
    expect(coverageDetail(coverage, "BBC", ["Tech/AI", "Football", "Cybersecurity"], [])).toBe("3 of your topics");
    expect(coverageDetail(coverage, "The Guardian", [], ["France", "Morocco"])).toBe("France, Morocco");
    expect(coverageDetail(coverage, "Kicker", ["Tech/AI"], [])).toBeNull();
  });
});
