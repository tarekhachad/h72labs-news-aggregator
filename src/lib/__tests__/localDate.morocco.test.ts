import { describe, it, expect, vi, afterEach } from "vitest";
import { dateInTimeZone, moroccoCorrectedZone, MOROCCO_GMT_SINCE } from "@/lib/localDate";

const at = (iso: string) => new Date(iso);

describe("moroccoCorrectedZone", () => {
  it("reads a Moroccan zone as UTC from the move onward, on a runtime with the old rules", () => {
    expect(moroccoCorrectedZone("Africa/Casablanca", new Date(MOROCCO_GMT_SINCE), true)).toBe("UTC");
    expect(moroccoCorrectedZone("Africa/El_Aaiun", at("2027-06-01T12:00:00Z"), true)).toBe("UTC");
  });

  it("leaves the zone alone before the move", () => {
    expect(moroccoCorrectedZone("Africa/Casablanca", new Date(MOROCCO_GMT_SINCE - 1), true)).toBe("Africa/Casablanca");
  });

  it("does nothing on a runtime that already has the new rules", () => {
    expect(moroccoCorrectedZone("Africa/Casablanca", at("2027-06-01T12:00:00Z"), false)).toBe("Africa/Casablanca");
  });

  it("never touches any other zone", () => {
    expect(moroccoCorrectedZone("Europe/Paris", at("2027-06-01T12:00:00Z"), true)).toBe("Europe/Paris");
    expect(moroccoCorrectedZone("UTC", at("2027-06-01T12:00:00Z"), true)).toBe("UTC");
  });
});

// These assert Morocco's current rules and must pass on every runtime: with
// the old tz database the correction supplies them, with the new one the
// runtime does.
describe("dateInTimeZone for Morocco", () => {
  it("keeps 23:30 UTC on the same day after the move", () => {
    expect(dateInTimeZone(at("2026-12-31T23:30:00Z"), "Africa/Casablanca")).toBe("2026-12-31");
    expect(dateInTimeZone(at("2026-10-15T23:30:00Z"), "Africa/Casablanca")).toBe("2026-10-15");
    expect(dateInTimeZone(at("2026-09-20T23:30:00Z"), "Africa/Casablanca")).toBe("2026-09-20");
    expect(dateInTimeZone(at("2026-12-31T23:30:00Z"), "Africa/El_Aaiun")).toBe("2026-12-31");
  });

  it("still applies UTC+1 before the move", () => {
    expect(dateInTimeZone(at("2026-06-01T23:30:00Z"), "Africa/Casablanca")).toBe("2026-06-02");
    expect(dateInTimeZone(at("2026-09-19T23:30:00Z"), "Africa/Casablanca")).toBe("2026-09-20");
  });
});

describe("the runtime tz log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("logs the runtime's tz database once per process, and only when a Moroccan zone asks", async () => {
    vi.resetModules();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fresh = await import("@/lib/localDate");

    fresh.dateInTimeZone(at("2026-10-15T12:00:00Z"), "America/New_York");
    expect(log).not.toHaveBeenCalled();

    fresh.dateInTimeZone(at("2026-10-15T12:00:00Z"), "Africa/Casablanca");
    fresh.dateInTimeZone(at("2026-10-16T12:00:00Z"), "Africa/El_Aaiun");
    const tzLines = log.mock.calls.filter((c) => String(c[0]).startsWith("[tz] runtime tz database"));
    expect(tzLines).toHaveLength(1);
    expect(String(tzLines[0][0])).toContain(process.versions.tz as string);
  });
});
