import { describe, it, expect } from "vitest";
import { editionSummary } from "@/components/newspaper/EditionStrip";
import { dateInTimeZone } from "@/lib/localDate";
import { makeCard } from "./editionTestKit";

// The strip's "updated HH:MM" is the reader's clock, not UTC's.

describe("editionSummary in the reader's zone", () => {
  const cards = [
    makeCard("a", { generatedAt: "2026-10-08T07:12:00Z" }),
    makeCard("b", { generatedAt: "2026-10-08T05:00:00Z" }),
  ];

  it("New York reads 03:12 for 07:12Z", () => {
    expect(editionSummary(cards, "America/New_York")).toBe("2 stories · updated 03:12");
  });

  it("Tokyo reads 16:12 for 07:12Z", () => {
    expect(editionSummary(cards, "Asia/Tokyo")).toBe("2 stories · updated 16:12");
  });

  it("Kolkata's half-hour offset reads 12:42", () => {
    expect(editionSummary(cards, "Asia/Kolkata")).toBe("2 stories · updated 12:42");
  });

  it("a stamp that crosses midnight in the reader's zone is 00:xx, not 24:xx", () => {
    expect(editionSummary([makeCard("m", { generatedAt: "2026-10-08T04:05:00Z" })], "America/New_York")).toBe(
      "1 story · updated 00:05"
    );
  });

  it("uses the newest stamp, whatever the card order, and ignores unparseable ones", () => {
    expect(
      editionSummary(
        [
          makeCard("x", { generatedAt: "garbage" }),
          makeCard("y", { generatedAt: "2026-10-08T09:30:00Z" }),
          makeCard("z", { generatedAt: "2026-10-08T01:00:00Z" }),
        ],
        "UTC"
      )
    ).toBe("3 stories · updated 09:30");
  });

  it("an unknown zone shows the count alone", () => {
    expect(editionSummary(cards, "Not/AZone")).toBe("2 stories");
  });

  // Morocco is UTC+0 from MOROCCO_GMT_SINCE (localDate.ts); runtimes with
  // older tz data still apply UTC+1. The app corrects for that in
  // dateInTimeZone, and the strip's time must agree with that reading
  // of the reader's clock: 07:12Z is 07:12 in Casablanca.
  it("Casablanca after the 2026 move reads 07:12 for 07:12Z, agreeing with the app's corrected zone", () => {
    // Sanity: the app's own corrected day for Casablanca.
    expect(dateInTimeZone(new Date("2026-10-08T23:30:00Z"), "Africa/Casablanca")).toBe("2026-10-08");
    expect(editionSummary(cards, "Africa/Casablanca")).toBe("2 stories · updated 07:12");
  });
});
