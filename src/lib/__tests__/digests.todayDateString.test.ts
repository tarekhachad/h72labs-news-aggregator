import { describe, it, expect, afterEach, vi } from "vitest";
import { todayDateString } from "@/lib/digests";

/**
 * Direct unit tests for todayDateString() itself — it was module-private
 * until Phase 8.1 exported it for the two history redirect guards to call
 * directly. Before this file, its UTC-vs-local behavior was only exercised
 * indirectly (through listDigestDatesForUser's use of it to build a `.lt()`
 * cutoff) — never asserted against its own return value in isolation. A
 * regression here (e.g. someone "simplifying" it to a local-timezone
 * `Date` accessor) would otherwise only be caught transitively.
 */
describe("todayDateString", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a plain YYYY-MM-DD string", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00Z"));
    expect(todayDateString()).toBe("2026-08-12");
    expect(todayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("follows the UTC day, not a local one, right after UTC midnight", () => {
    // 00:00:01 UTC on the 12th is still the 11th across every timezone west
    // of UTC (all of the Americas, for instance). If this ever regressed to
    // reading local date components, this is the case that would catch it
    // on a machine/CI runner set to a non-UTC TZ.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:01Z"));
    expect(todayDateString()).toBe("2026-08-12");
  });

  it("follows the UTC day right before UTC midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T23:59:59Z"));
    expect(todayDateString()).toBe("2026-08-12");
  });

  it("rolls over to the next UTC day exactly at the boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T23:59:59.999Z"));
    expect(todayDateString()).toBe("2026-08-12");
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    expect(todayDateString()).toBe("2026-08-13");
  });

  it("zero-pads single-digit months and days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T12:00:00Z"));
    expect(todayDateString()).toBe("2026-01-05");
  });

  it("handles a UTC year rollover (Dec 31 -> Jan 1)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T23:00:00Z"));
    expect(todayDateString()).toBe("2026-12-31");
    vi.setSystemTime(new Date("2027-01-01T00:30:00Z"));
    expect(todayDateString()).toBe("2027-01-01");
  });
});
