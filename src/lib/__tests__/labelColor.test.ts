import { describe, it, expect } from "vitest";
import { labelColor } from "@/lib/labelColor";

describe("labelColor", () => {
  it("is deterministic — the same label always maps to the same pair", () => {
    expect(labelColor("Funding")).toEqual(labelColor("Funding"));
  });

  it("normalizes case and surrounding whitespace before hashing", () => {
    const canonical = labelColor("Funding");
    expect(labelColor("funding")).toEqual(canonical);
    expect(labelColor("FUNDING")).toEqual(canonical);
    expect(labelColor("  Funding  ")).toEqual(canonical);
  });

  it("returns a background/color pair referencing one of the 6 palette tokens", () => {
    const { background, color } = labelColor("Startups");
    expect(background).toMatch(/^var\(--label-bg-[1-6]\)$/);
    expect(color).toMatch(/^var\(--label-fg-[1-6]\)$/);
    // background and color must always be the same index — a bg-2/fg-5
    // mismatch would mean a bug in how the index feeds both lookups.
    const bgIndex = background.match(/\d/)?.[0];
    const fgIndex = color.match(/\d/)?.[0];
    expect(fgIndex).toBe(bgIndex);
  });

  it("distributes a varied set of labels across more than one palette bucket", () => {
    // Not a strict uniformity test (hash distribution over 6 buckets with
    // a handful of inputs can legitimately collide) — just a sanity check
    // that this isn't secretly a constant function always returning the
    // same bucket regardless of input.
    const labels = [
      "Funding",
      "Startups",
      "Elections",
      "Trade Policy",
      "Layoffs",
      "Mergers",
      "Sanctions",
      "Championships",
    ];
    const buckets = new Set(labels.map((l) => labelColor(l).background));
    expect(buckets.size).toBeGreaterThan(1);
  });
});
