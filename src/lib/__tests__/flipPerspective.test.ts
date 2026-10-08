import { describe, expect, it } from "vitest";
import {
  FLIP_OVERFLOW_BOUND_PX,
  MIN_FLIP_PERSPECTIVE_PX,
  flipPerspectivePx,
} from "@/lib/flipPerspective";

/**
 * Independent of the formula: projects the card's four corners through a
 * perspective camera at distance p, rotated by rotateX(θ) about the card's
 * centre, and returns how far the outline reaches past the unrotated box on
 * the worst side, over a fine sweep of angles.
 */
function maxOverflow(width: number, height: number, p: number): number {
  let worst = -Infinity;
  for (let step = 0; step <= 1800; step++) {
    const theta = (step / 1800) * Math.PI;
    for (const x of [-width / 2, width / 2]) {
      for (const y of [-height / 2, height / 2]) {
        const z = y * Math.sin(theta);
        if (z >= p) continue;
        const s = p / (p - z);
        const px = x * s;
        const py = y * Math.cos(theta) * s;
        worst = Math.max(worst, Math.abs(px) - width / 2, Math.abs(py) - height / 2);
      }
    }
  }
  return worst;
}

// Real card boxes: 6 columns, gap-5 (20 px), 180 px rows; page padding
// px-10 (md+) or px-6 below. Hero/medium are 2 rows (380 px), small 1 row.
const CASES: Array<[string, number, number]> = [
  ["hero at a 1920 px window", 1840, 380],
  ["hero at a 1440 px window", 1360, 380],
  ["medium (3 of 6 columns) at 1440", 670, 380],
  ["small (2 of 6 columns) at 1440", 440, 180],
  ["small widened to full width at 1440", 1360, 180],
  ["hero on a 390 px phone", 342, 380],
  ["a tall, narrow box", 40, 2000],
];

describe("flipPerspectivePx", () => {
  it.each(CASES)("keeps %s within the bound at every angle", (_label, w, h) => {
    const p = flipPerspectivePx(w, h);
    expect(maxOverflow(w, h, p)).toBeLessThanOrEqual(FLIP_OVERFLOW_BOUND_PX + 1e-6);
  });

  it("is tight: 2% less depth on a hero breaks the bound", () => {
    const p = flipPerspectivePx(1360, 380);
    expect(maxOverflow(1360, 380, p * 0.98)).toBeGreaterThan(FLIP_OVERFLOW_BOUND_PX);
  });

  it("the old fixed 1200 px spills a hero well past the bound", () => {
    expect(maxOverflow(1360, 380, 1200)).toBeGreaterThan(100);
  });

  it("never goes below today's 1200 px depth", () => {
    expect(flipPerspectivePx(10, 10)).toBe(MIN_FLIP_PERSPECTIVE_PX);
    expect(flipPerspectivePx(100, 100)).toBe(MIN_FLIP_PERSPECTIVE_PX);
  });

  it("grows with width (the near edge's sideways spread is what bites)", () => {
    expect(flipPerspectivePx(1840, 380)).toBeGreaterThan(flipPerspectivePx(1360, 380));
    expect(flipPerspectivePx(1360, 380)).toBeGreaterThan(flipPerspectivePx(670, 380));
  });

  it("is a whole number of px", () => {
    expect(Number.isInteger(flipPerspectivePx(1361.5, 379.25))).toBe(true);
  });

  it.each([
    [0, 380],
    [1360, 0],
    [-5, 380],
    [Number.NaN, 380],
    [Number.POSITIVE_INFINITY, 380],
  ])("falls back to the floor for an unmeasured size (%s × %s)", (w, h) => {
    expect(flipPerspectivePx(w, h)).toBe(MIN_FLIP_PERSPECTIVE_PX);
  });

  it("honours a custom bound", () => {
    const p = flipPerspectivePx(1360, 380, 4);
    expect(maxOverflow(1360, 380, p)).toBeLessThanOrEqual(4 + 1e-6);
  });
});
