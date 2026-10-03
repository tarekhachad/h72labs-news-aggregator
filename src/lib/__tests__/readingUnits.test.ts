import { describe, it, expect } from "vitest";
import { TOPICS } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { countReadingUnits, MAX_READING_UNITS, readingUnits } from "@/lib/readingUnits";

const [a, b, c] = TOPICS.filter((topic) => topic !== COUNTRIES_TOPIC);

describe("countReadingUnits", () => {
  it("counts topics one each", () => {
    expect(countReadingUnits([a, b, c], [])).toBe(3);
  });

  it("counts each country, not the Countries container", () => {
    expect(countReadingUnits([a, COUNTRIES_TOPIC], ["Uganda", "Kenya"])).toBe(3);
  });

  it("ignores countries when Countries isn't picked", () => {
    expect(countReadingUnits([a, b], ["Uganda"])).toBe(2);
  });

  it("counts Countries with no countries as nothing", () => {
    expect(countReadingUnits([a, COUNTRIES_TOPIC], [])).toBe(1);
  });

  it("counts duplicates once", () => {
    expect(countReadingUnits([a, a, COUNTRIES_TOPIC], ["Uganda", "Uganda"])).toBe(2);
  });
});

describe("readingUnits", () => {
  it("expands Countries in place into one unit per country", () => {
    const { read } = readingUnits([COUNTRIES_TOPIC, a], ["Uganda", "Kenya"]);
    expect(read.filter((unit) => unit.topic === COUNTRIES_TOPIC).map((unit) => unit.subtopic).sort()).toEqual(["Kenya", "Uganda"]);
    expect(read.find((unit) => unit.topic === a)).toEqual({ topic: a, subtopic: null });
    expect(read).toHaveLength(3);
  });

  it("follows TOPICS order, with countries at the Countries position", () => {
    const { read } = readingUnits([...TOPICS].reverse(), ["Uganda"]);
    const positions = read.map((unit) => TOPICS.indexOf(unit.topic));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  it(`reads at most ${MAX_READING_UNITS} units and reports the rest as dropped`, () => {
    const topics = TOPICS.filter((topic) => topic !== COUNTRIES_TOPIC).slice(0, 8);
    const { read, dropped } = readingUnits([...topics, COUNTRIES_TOPIC], ["Uganda", "Kenya", "Morocco"]);
    expect(read).toHaveLength(MAX_READING_UNITS);
    expect(dropped).toBe(1);
  });

  it("ignores countries without the Countries topic", () => {
    expect(readingUnits([a], ["Uganda"]).read).toEqual([{ topic: a, subtopic: null }]);
  });
});
