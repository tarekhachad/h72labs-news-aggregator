import { describe, it, expect, vi, afterEach } from "vitest";
import { editionSummary } from "@/components/newspaper/EditionStrip";
import { MOROCCO_GMT_SINCE, dateInTimeZone } from "@/lib/localDate";
import { makeCard } from "./editionTestKit";

// The strip's "updated HH:MM" applies the same Morocco correction
// as dateInTimeZone. Expectations are the real (2026c+) rules, so they hold
// on a runtime with stale tz data (the correction on) and on a fresh one
// (the correction off).

const at = (iso: string) => [makeCard("a", { generatedAt: iso })];
const hhmm = (iso: string, zone: string) => editionSummary(at(iso), zone).replace(/^1 story · updated /, "");

function rawIntl(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(
    new Date(iso)
  );
}

describe("editionSummary, Morocco after the 2026 move (UTC+0)", () => {
  for (const zone of ["Africa/Casablanca", "Africa/El_Aaiun"]) {
    it(`${zone}: 07:12Z reads 07:12`, () => {
      expect(hhmm("2026-10-08T07:12:00Z", zone)).toBe("07:12");
    });

    it(`${zone}: 23:30Z reads 23:30, not 00:30, and agrees with the app's date for that instant`, () => {
      expect(hhmm("2026-10-08T23:30:00Z", zone)).toBe("23:30");
      expect(dateInTimeZone(new Date("2026-10-08T23:30:00Z"), zone)).toBe("2026-10-08");
    });

    it(`${zone}: exactly at the move (01:00Z on 2026-09-20) reads 01:00`, () => {
      expect(new Date("2026-09-20T01:00:00Z").getTime()).toBe(MOROCCO_GMT_SINCE);
      expect(hhmm("2026-09-20T01:00:00Z", zone)).toBe("01:00");
    });
  }
});

describe("editionSummary, Morocco before the move (old UTC+1 still applies)", () => {
  for (const zone of ["Africa/Casablanca", "Africa/El_Aaiun"]) {
    it(`${zone}: 12:00Z on 2026-09-19 reads 13:00`, () => {
      expect(hhmm("2026-09-19T12:00:00Z", zone)).toBe("13:00");
    });

    it(`${zone}: one minute before the move (00:59Z) reads 01:59`, () => {
      expect(hhmm("2026-09-20T00:59:00Z", zone)).toBe("01:59");
    });

    it(`${zone}: one millisecond before the move is not corrected`, () => {
      const iso = new Date(MOROCCO_GMT_SINCE - 1).toISOString();
      expect(hhmm(iso, zone)).toBe("01:59");
    });
  }

  it("the correction follows the newest stamp: a pre-move card plus a post-move card reads the post-move time in UTC+0", () => {
    const cards = [
      makeCard("old", { generatedAt: "2026-09-19T12:00:00Z" }),
      makeCard("new", { generatedAt: "2026-10-01T20:45:00Z" }),
    ];
    expect(editionSummary(cards, "Africa/Casablanca")).toBe("2 stories · updated 20:45");
  });

  it("the newest stamp before the move keeps UTC+1 even when an older one is also pre-move", () => {
    const cards = [
      makeCard("a", { generatedAt: "2026-09-18T10:00:00Z" }),
      makeCard("b", { generatedAt: "2026-09-19T22:10:00Z" }),
    ];
    expect(editionSummary(cards, "Africa/El_Aaiun")).toBe("2 stories · updated 23:10");
  });
});

describe("editionSummary, non-Moroccan zones are untouched by the correction", () => {
  // Africa/Ceuta is the Spanish city on Morocco's coast: CET/CEST, not Morocco's rules.
  const zones = [
    "UTC",
    "Europe/London",
    "Europe/Lisbon",
    "Atlantic/Canary",
    "Africa/Ceuta",
    "Europe/Madrid",
    "Africa/Algiers",
    "Africa/Lagos",
    "Africa/Cairo",
    "Asia/Kolkata",
    "America/New_York",
    "Pacific/Chatham",
  ];
  const instants = ["2026-09-19T12:00:00Z", "2026-09-20T01:00:00Z", "2026-10-08T07:12:00Z", "2026-10-08T23:30:00Z"];
  for (const zone of zones) {
    it(`${zone} matches plain Intl at every instant`, () => {
      for (const iso of instants) expect(hhmm(iso, zone)).toBe(rawIntl(iso, zone));
    });
  }
});

describe("editionSummary on a runtime that already has the new Morocco rules", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("the probe reads 'fresh', the correction stays off, and times are still right on both sides of the move", async () => {
    const RealDTF = Intl.DateTimeFormat;
    const MOROCCO = new Set(["Africa/Casablanca", "Africa/El_Aaiun"]);
    let moroccanFormatters = 0;
    // A DateTimeFormat whose Morocco rules are the 2026c ones: UTC from the
    // move on, the runtime's own (UTC+1) before it.
    function FreshDTF(locale?: string | string[], opts?: Intl.DateTimeFormatOptions) {
      const old = new RealDTF(locale, opts);
      if (!opts?.timeZone || !MOROCCO.has(opts.timeZone)) return old;
      moroccanFormatters++;
      const utc = new RealDTF(locale, { ...opts, timeZone: "UTC" });
      const pick = (d?: Date | number) => (new Date(d ?? Date.now()).getTime() >= MOROCCO_GMT_SINCE ? utc : old);
      return {
        format: (d?: Date | number) => pick(d).format(d),
        formatToParts: (d?: Date | number) => pick(d).formatToParts(d),
        resolvedOptions: () => old.resolvedOptions(),
      };
    }
    vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: FreshDTF });
    vi.resetModules();
    const fresh = await import("@/components/newspaper/EditionStrip");
    const at1 = (iso: string, zone: string) => fresh.editionSummary(at(iso), zone);
    expect(at1("2026-10-08T07:12:00Z", "Africa/Casablanca")).toBe("1 story · updated 07:12");
    expect(at1("2026-10-08T23:30:00Z", "Africa/El_Aaiun")).toBe("1 story · updated 23:30");
    expect(at1("2026-09-19T12:00:00Z", "Africa/Casablanca")).toBe("1 story · updated 13:00");
    // The formatting itself went through the Moroccan zone (the correction
    // did not swap it for UTC), proving the probe read the runtime as fresh.
    expect(moroccanFormatters).toBeGreaterThanOrEqual(4);
  });
});
