import { describe, it, expect } from "vitest";
import { editionSummary } from "@/components/newspaper/EditionStrip";
import { railStepsReached, runningStageLabel } from "@/components/newspaper/editionStages";
import { makeCard } from "./editionTestKit";

describe("editionSummary", () => {
  it("counts every card and takes the newest generatedAt, in the reader's time zone", () => {
    const cards = [
      makeCard("a", { generatedAt: "2026-10-08T05:00:00Z" }),
      makeCard("b", { generatedAt: "2026-10-08T07:12:00Z" }),
    ];
    expect(editionSummary(cards, "UTC")).toBe("2 stories · updated 07:12");
    // UTC+0 since Morocco's 2026 move, whatever this runtime's tz data says.
    expect(editionSummary(cards, "Africa/Casablanca")).toBe("2 stories · updated 07:12");
    expect(editionSummary(cards, "America/New_York")).toBe("2 stories · updated 03:12");
  });

  it("uses a 24-hour clock", () => {
    expect(editionSummary([makeCard("a", { generatedAt: "2026-10-08T19:05:00Z" })], "UTC")).toBe(
      "1 story · updated 19:05"
    );
  });

  it("falls back to the count alone when no stamp parses or the zone is unknown", () => {
    expect(editionSummary([makeCard("a", { generatedAt: "x" })], "UTC")).toBe("1 story");
    expect(editionSummary([makeCard("a")], "Not/AZone")).toBe("1 story");
  });

  it("ignores an unparseable stamp beside a good one", () => {
    const cards = [makeCard("a", { generatedAt: "" }), makeCard("b", { generatedAt: "2026-10-08T07:12:00Z" })];
    expect(editionSummary(cards, "UTC")).toBe("2 stories · updated 07:12");
  });
});

describe("edition stages", () => {
  it("lights one rail step per stage reached, all five by ranking and done", () => {
    expect(railStepsReached(null)).toBe(1);
    expect(railStepsReached({ stage: "ingesting" })).toBe(1);
    expect(railStepsReached({ stage: "clustering" })).toBe(2);
    expect(railStepsReached({ stage: "triaging" })).toBe(3);
    expect(railStepsReached({ stage: "writing" })).toBe(4);
    expect(railStepsReached({ stage: "ranking" })).toBe(5);
    expect(railStepsReached({ stage: "done" })).toBe(5);
  });

  it("reads a run that has sent nothing yet as gathering", () => {
    expect(runningStageLabel(null)).toBe("Gathering articles…");
    expect(runningStageLabel({ stage: "writing", notableCount: 1 })).toBe("Writing 1 card…");
  });
});
