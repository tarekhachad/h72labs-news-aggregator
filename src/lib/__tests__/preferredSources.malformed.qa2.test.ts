import { describe, it, expect } from "vitest";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { countPreferredSources } from "@/lib/preferredSources";
import { getTodaysCardSummaries } from "@/lib/digests";

// QA round 2: a card's stored `sources` jsonb is read back and counted after
// the run's cards were paid for. Any malformed shape must count as nothing,
// never throw, and never count something that is not a real preferred outlet.
// Never names a topic or an outlet.

const TOPIC = TOPICS[0] as Topic;
const [P1, P2, O1] = SOURCES.slice(0, 3) as Source[];

function client(rows: unknown[]) {
  const eq = async () => ({ data: rows, error: null });
  return { from: () => ({ select: () => ({ eq }) }) };
}
async function summariesOf(rows: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getTodaysCardSummaries(client(rows) as any, "d");
}
const row = (sources: unknown) => ({ id: "a", topic: TOPIC, short_summary: "x", severity: 2, sources });

describe("countPreferredSources on malformed stored entries", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a bare outlet-name string", P1],
    ["a boolean", true],
    ["an empty object", {}],
    ["source: null", { source: null }],
    ["source: a number", { source: 1 }],
    ["source: an object", { source: { name: P1 } }],
    ["source: an array holding the outlet", { source: [P1] }],
    ["an array", [P1]],
  ])("%s counts as nothing and does not throw", (_l, entry) => {
    expect(countPreferredSources([entry] as never, [P1])).toBe(0);
  });

  it("good entries around malformed ones still count, distinct", () => {
    const items = [null, { source: P1 }, 3, { source: P1 }, "x", { source: P2 }, {}, { source: O1 }];
    expect(countPreferredSources(items as never, [P1, P2])).toBe(2);
  });

  it("a differently-cased or padded outlet name is not that outlet", () => {
    const items = [{ source: P1.toUpperCase() === P1 ? P1.toLowerCase() : P1.toUpperCase() }, { source: ` ${P1}` }];
    expect(countPreferredSources(items as never, [P1])).toBe(0);
  });
});

describe("getTodaysCardSummaries sources read-back", () => {
  it.each([
    ["null", null],
    ["missing", undefined],
    ["an object", { source: P1 }],
    ["a string", JSON.stringify([{ source: P1 }])],
    ["a number", 3],
  ])("a non-array sources value (%s) reads as [] and counts zero", async (_l, sources) => {
    const [s] = await summariesOf([row(sources)]);
    expect(s.sources).toEqual([]);
    expect(countPreferredSources(s.sources, [P1])).toBe(0);
  });

  it("an array of mixed good and malformed entries reaches the counter and counts only the good ones", async () => {
    const [s] = await summariesOf([row([null, 5, { source: P1 }, { source: O1 }, { source: P1 }])]);
    expect(countPreferredSources(s.sources, [P1, O1])).toBe(2);
  });

  it("a null severity still reads as 1 alongside the new sources field", async () => {
    const [s] = await summariesOf([{ ...row([]), severity: null }]);
    expect(s.severity).toBe(1);
  });
});
