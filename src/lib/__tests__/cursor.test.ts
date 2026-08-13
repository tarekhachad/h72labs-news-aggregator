import { describe, it, expect } from "vitest";
import {
  FUTURE_CURSOR_TOLERANCE_MS,
  isImplausiblyFuture,
  plausibleCursorLimitIso,
} from "@/lib/cursor";

// The point of this module is that two call sites -- the query in digests.ts
// that refuses to SELECT a corrupt cursor, and the cutoff in ingest.ts that
// refuses to USE one -- agree on the same threshold. These tests pin the
// threshold itself, so a drift shows up here rather than as a silent
// every-run 48h re-ingest in production.

const NOW = new Date("2026-08-13T12:00:00Z").getTime();

describe("isImplausiblyFuture", () => {
  it("accepts a past timestamp", () => {
    expect(isImplausiblyFuture(new Date(NOW - 60_000), NOW)).toBe(false);
  });

  it("accepts a timestamp exactly at the tolerance", () => {
    const at = new Date(NOW + FUTURE_CURSOR_TOLERANCE_MS);
    expect(isImplausiblyFuture(at, NOW)).toBe(false);
  });

  it("rejects one millisecond past the tolerance", () => {
    const past = new Date(NOW + FUTURE_CURSOR_TOLERANCE_MS + 1);
    expect(isImplausiblyFuture(past, NOW)).toBe(true);
  });

  it("accepts ordinary skew of a few seconds", () => {
    // The case that must NOT be read as corruption: treating it that way
    // would make every run fall back to the 48h window forever.
    expect(isImplausiblyFuture(new Date(NOW + 5_000), NOW)).toBe(false);
  });

  it("rejects a timestamp days ahead", () => {
    expect(isImplausiblyFuture(new Date(NOW + 72 * 60 * 60 * 1000), NOW)).toBe(true);
  });
});

describe("plausibleCursorLimitIso", () => {
  it("is exactly now plus the tolerance, as an ISO string", () => {
    expect(plausibleCursorLimitIso(NOW)).toBe("2026-08-13T12:05:00.000Z");
  });

  it("agrees with isImplausiblyFuture at the boundary", () => {
    // The query filter is `<= limit`, so the newest value the query accepts
    // must be exactly the newest value the consumer accepts. If these two
    // ever disagree, the query hands back a cursor ingest then discards.
    const limit = new Date(plausibleCursorLimitIso(NOW));
    expect(isImplausiblyFuture(limit, NOW)).toBe(false);
    expect(isImplausiblyFuture(new Date(limit.getTime() + 1), NOW)).toBe(true);
  });
});
