import { describe, it, expect } from "vitest";
import type { Card } from "@/types";
import { editionSummary } from "@/components/newspaper/EditionStrip";
import { moroccoCorrectedZone } from "@/lib/localDate";
import { makeCard } from "./editionTestKit";

// QA round 1: editionSummary now formats through localDate's timeInTimeZone
// instead of its own Morocco probe and try/catch. This pins the new function
// to a verbatim copy of the one it replaced, over every zone this runtime
// knows plus the odd names a stored value could hold, at instants around the
// Morocco move, DST edges and midnight. Any difference is a regression.

const MOROCCO_ZONES = new Set(["Africa/Casablanca", "Africa/El_Aaiun"]);
let moroccoRulesStale: boolean | undefined;
function runtimeHasStaleMoroccoRules(): boolean {
  if (moroccoRulesStale === undefined) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca", day: "2-digit" }).format(
      new Date(Date.UTC(2026, 8, 25, 23, 30))
    );
    moroccoRulesStale = day === "26";
  }
  return moroccoRulesStale;
}

/** The pre-change editionSummary, copied from fa186b4. */
function previousEditionSummary(cards: Card[], timeZone: string): string {
  const count = `${cards.length} ${cards.length === 1 ? "story" : "stories"}`;
  let latest = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const t = Date.parse(card.generatedAt);
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  if (!Number.isFinite(latest)) return count;
  let time: string;
  try {
    const stale = MOROCCO_ZONES.has(timeZone) && runtimeHasStaleMoroccoRules();
    time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: moroccoCorrectedZone(timeZone, new Date(latest), stale),
    }).format(latest);
  } catch {
    return count;
  }
  return `${count} · updated ${time}`;
}

const INSTANTS = [
  "2026-01-01T00:00:00Z",
  "2026-03-08T06:59:00Z", // just before US DST
  "2026-03-08T07:00:00Z",
  "2026-03-29T00:59:59Z", // just before EU DST
  "2026-03-29T01:00:00Z",
  "2026-09-19T12:00:00Z", // Morocco before the move
  "2026-09-20T00:59:59.999Z",
  "2026-09-20T01:00:00Z", // the move
  "2026-09-25T23:30:00Z", // the probe's own instant
  "2026-10-08T23:30:00Z",
  "2026-10-25T00:30:00Z",
  "2026-11-01T05:59:00Z",
  "2026-12-31T23:59:59Z",
  "2027-02-15T23:30:00Z", // around a Ramadan under the old rules
  "2027-06-01T23:30:00Z",
  "2030-01-01T12:34:00Z",
];

const ODD_ZONES = [
  "UTC",
  "utc",
  "Etc/UTC",
  "GMT",
  "Etc/GMT+5",
  "Etc/GMT-14",
  "+05:30",
  "-03:00",
  "africa/casablanca", // Intl accepts any case; the Morocco set does not
  "AFRICA/EL_AAIUN",
  "Europe/Kiev", // alias
  "US/Eastern", // backward link
  "Asia/Calcutta",
  "",
  " UTC",
  "UTC ",
  "Not/AZone",
  "Mars/Olympus_Mons",
  "../../etc/passwd",
];

describe("editionSummary matches the implementation it replaced", () => {
  const zones = [...Intl.supportedValuesOf("timeZone"), ...ODD_ZONES];

  it(`one stamp, ${zones.length} zones x ${INSTANTS.length} instants`, () => {
    const diffs: string[] = [];
    for (const zone of zones) {
      for (const iso of INSTANTS) {
        const cards = [makeCard("a", { generatedAt: iso })];
        const got = editionSummary(cards, zone);
        const want = previousEditionSummary(cards, zone);
        if (got !== want) diffs.push(`${JSON.stringify(zone)} ${iso}: got "${got}" want "${want}"`);
      }
    }
    expect(diffs.slice(0, 10)).toEqual([]);
  });

  it("many cards: newest parseable stamp wins, garbage stamps ignored, count kept", () => {
    const cards = [
      makeCard("a", { generatedAt: "2026-10-08T07:12:00Z" }),
      makeCard("b", { generatedAt: "not a date" }),
      makeCard("c", { generatedAt: "" }),
      makeCard("d", { generatedAt: "2026-10-08T23:30:00Z" }),
      makeCard("e", { generatedAt: "2026-10-08T23:29:59.999+00:00" }),
    ];
    for (const zone of ["UTC", "Africa/Casablanca", "Africa/El_Aaiun", "Asia/Tokyo", "Not/AZone", ""]) {
      expect(editionSummary(cards, zone)).toBe(previousEditionSummary(cards, zone));
    }
    expect(editionSummary(cards, "Africa/Casablanca")).toBe("5 stories · updated 23:30");
  });

  it("no cards, all-garbage stamps and a single card keep the old count wording", () => {
    for (const cards of [
      [],
      [makeCard("a", { generatedAt: "garbage" })],
      [makeCard("a", { generatedAt: "garbage" }), makeCard("b", { generatedAt: "" })],
    ]) {
      for (const zone of ["UTC", "Not/AZone"]) {
        expect(editionSummary(cards, zone)).toBe(previousEditionSummary(cards, zone));
      }
    }
    expect(editionSummary([], "UTC")).toBe("0 stories");
    expect(editionSummary([makeCard("a", { generatedAt: "x" })], "UTC")).toBe("1 story");
  });

  it("a rejected zone shows the count alone, never a UTC time passed off as local", () => {
    const cards = [makeCard("a", { generatedAt: "2026-10-08T07:12:00Z" })];
    expect(editionSummary(cards, "Not/AZone")).toBe("1 story");
    expect(editionSummary(cards, "")).toBe("1 story");
  });
});
