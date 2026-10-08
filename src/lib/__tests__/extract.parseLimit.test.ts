import { describe, it, expect } from "vitest";
import { PARSE_TIMEOUT_MS } from "@/lib/extract";

// The heaviest real-shaped page (~16,000 tags) ran past 1.5 s on CI's slower
// CPU, which costs it its full text and marks its outlet heavy. The timing
// tests derive their bounds from this constant, so lowering it would not turn
// them red; this does.
describe("parser time limit", () => {
  it("gives a page at least 3 s", () => {
    expect(PARSE_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);
  });
});
