import { describe, it, expect, afterEach, vi } from "vitest";
import { todayDateString } from "@/lib/digests";

/**
 * todayDateString is the server's one "which calendar day is today" call,
 * and every page guard, the history list and the digest row choice go
 * through it. The UTC cases pin the arithmetic at the boundaries; the zone
 * cases pin that the argument is actually used rather than ignored.
 */
describe("todayDateString", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a plain YYYY-MM-DD string", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00Z"));
    expect(todayDateString("UTC")).toBe("2026-08-12");
    expect(todayDateString("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("follows the UTC day, not a local one, right after UTC midnight", () => {
    // 00:00:01 UTC on the 12th is still the 11th across every timezone west
    // of UTC (all of the Americas, for instance). If this ever regressed to
    // reading local date components, this is the case that would catch it
    // on a machine/CI runner set to a non-UTC TZ.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:01Z"));
    expect(todayDateString("UTC")).toBe("2026-08-12");
  });

  it("follows the UTC day right before UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T23:59:59Z"));
    expect(todayDateString("UTC")).toBe("2026-08-12");
  });

  it("rolls over to the next UTC day exactly at the boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T23:59:59.999Z"));
    expect(todayDateString("UTC")).toBe("2026-08-12");
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    expect(todayDateString("UTC")).toBe("2026-08-13");
  });

  it("zero-pads single-digit months and days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T12:00:00Z"));
    expect(todayDateString("UTC")).toBe("2026-01-05");
  });

  it("handles a UTC year rollover (Dec 31 -> Jan 1)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T23:00:00Z"));
    expect(todayDateString("UTC")).toBe("2026-12-31");
    vi.setSystemTime(new Date("2027-01-01T00:30:00Z"));
    expect(todayDateString("UTC")).toBe("2027-01-01");
  });

  it("returns the reader's local day when it differs from the UTC one", () => {
    // 00:30 UTC on the 23rd: still the 22nd from New York westward, already
    // the 23rd from Casablanca eastward. This is the case that filed Tarek's
    // own 8pm Atlanta digest under the next day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:30:00Z"));
    expect(todayDateString("America/New_York")).toBe("2026-09-22");
    expect(todayDateString("Pacific/Pago_Pago")).toBe("2026-09-22");
    expect(todayDateString("Africa/Casablanca")).toBe("2026-09-23");
    expect(todayDateString("Pacific/Kiritimati")).toBe("2026-09-23");
  });

  it("reaches the day after UTC for a zone far enough east", () => {
    // 11:00 UTC on the 22nd is 01:00 on the 23rd at UTC+14. The RPC's
    // one-day bound around the server date exists for exactly this.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T11:00:00Z"));
    expect(todayDateString("Pacific/Kiritimati")).toBe("2026-09-23");
  });

  it("falls back to the UTC day for a name Intl rejects", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:30:00Z"));
    expect(todayDateString("Mars/Olympus")).toBe("2026-09-23");
  });
});
