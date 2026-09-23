import { describe, it, expect, afterEach, vi } from "vitest";
import { dateInTimeZone, deviceTimeZone, isValidTimeZone, DEFAULT_TIME_ZONE } from "@/lib/localDate";

describe("dateInTimeZone", () => {
  const at = (iso: string) => new Date(iso);

  it("returns a zero-padded YYYY-MM-DD", () => {
    expect(dateInTimeZone(at("2026-01-05T12:00:00Z"), "UTC")).toBe("2026-01-05");
  });

  it("gives each zone its own calendar day at the same instant", () => {
    const instant = at("2026-09-23T00:30:00Z");
    expect(dateInTimeZone(instant, "America/New_York")).toBe("2026-09-22");
    expect(dateInTimeZone(instant, "Pacific/Pago_Pago")).toBe("2026-09-22");
    expect(dateInTimeZone(instant, "Africa/Casablanca")).toBe("2026-09-23");
    expect(dateInTimeZone(instant, "Pacific/Kiritimati")).toBe("2026-09-23");
  });

  it("rolls over at the zone's own midnight, not UTC's", () => {
    // New York is UTC-4 in September, so its midnight is 04:00 UTC.
    expect(dateInTimeZone(at("2026-09-23T03:59:59Z"), "America/New_York")).toBe("2026-09-22");
    expect(dateInTimeZone(at("2026-09-23T04:00:00Z"), "America/New_York")).toBe("2026-09-23");
  });

  it("follows daylight saving: midnight moves by an hour across the change", () => {
    // After 2026-11-01 New York is UTC-5, so midnight is 05:00 UTC. A fixed
    // -4 offset would call 04:30 UTC on the 2nd the 2nd; it is still the 1st.
    expect(dateInTimeZone(at("2026-11-02T04:30:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(dateInTimeZone(at("2026-11-02T05:00:00Z"), "America/New_York")).toBe("2026-11-02");
    // Spring forward, 2026-03-08: UTC-5 before, UTC-4 after the change.
    expect(dateInTimeZone(at("2026-03-08T04:59:59Z"), "America/New_York")).toBe("2026-03-07");
    expect(dateInTimeZone(at("2026-03-09T03:59:59Z"), "America/New_York")).toBe("2026-03-08");
    expect(dateInTimeZone(at("2026-03-09T04:00:00Z"), "America/New_York")).toBe("2026-03-09");
  });

  it("handles a year rollover in the reader's zone", () => {
    expect(dateInTimeZone(at("2027-01-01T03:00:00Z"), "America/New_York")).toBe("2026-12-31");
    expect(dateInTimeZone(at("2026-12-31T23:30:00Z"), "Africa/Casablanca")).toBe("2027-01-01");
  });

  it("falls back to UTC for a name Intl rejects instead of throwing", () => {
    const instant = at("2026-09-23T00:30:00Z");
    expect(() => dateInTimeZone(instant, "Mars/Olympus")).not.toThrow();
    expect(dateInTimeZone(instant, "Mars/Olympus")).toBe(dateInTimeZone(instant, DEFAULT_TIME_ZONE));
    expect(dateInTimeZone(instant, "")).toBe("2026-09-23");
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects anything else", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("rejects a missing zone rather than letting Intl substitute the host's", () => {
    // Intl treats `timeZone: undefined` as the host zone, which is not UTC on
    // a machine with TZ set, and would silently change which day is today.
    expect(isValidTimeZone(undefined as unknown as string)).toBe(false);
    expect(isValidTimeZone(null as unknown as string)).toBe(false);
  });
});

describe("dateInTimeZone with a missing zone", () => {
  it("falls back to UTC, not to the host's zone", () => {
    // 02:00 UTC is still the previous day in New York; a host-zone fallback
    // would return the 22nd on any machine running in the Americas.
    const instant = new Date("2026-09-23T02:00:00Z");
    expect(dateInTimeZone(instant, undefined as unknown as string)).toBe("2026-09-23");
  });
});

describe("deviceTimeZone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the runtime's resolved zone", () => {
    const expected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(deviceTimeZone()).toBe(expected);
  });

  it("returns null when Intl reports no zone", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: undefined,
    } as unknown as Intl.ResolvedDateTimeFormatOptions);
    expect(deviceTimeZone()).toBeNull();
  });
});
