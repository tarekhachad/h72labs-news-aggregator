import { describe, it, expect } from "vitest";
import { packGrid, GRID_COLUMNS, type GridItemInput } from "@/lib/packGrid";
import { TIER_DIMENSIONS, type GridTier } from "@/lib/gridTiers";

function parseSpan(value: string): { start: number; span: number } {
  const [start, , , span] = value.split(" ");
  return { start: Number(start), span: Number(span) };
}

/**
 * Asserts the packed layout has no row that ends with unfilled trailing
 * width — the exact bug class packGrid exists to fix (see packGrid.ts's
 * doc comment). Walks every occupied row and checks the rightmost occupied
 * column reaches the full 6-column width.
 */
function assertNoTrailingGaps(items: GridItemInput[], positions: Map<string, { gridColumn: string; gridRow: string }>) {
  const rightEdgeByRow = new Map<number, number>();
  for (const item of items) {
    const pos = positions.get(item.id)!;
    const col = parseSpan(pos.gridColumn);
    const row = parseSpan(pos.gridRow);
    for (let r = row.start; r < row.start + row.span; r++) {
      const edge = col.start + col.span - 1;
      rightEdgeByRow.set(r, Math.max(rightEdgeByRow.get(r) ?? 0, edge));
    }
  }
  for (const [row, edge] of rightEdgeByRow) {
    expect(edge, `row ${row} only reaches column ${edge}, expected ${GRID_COLUMNS}`).toBe(GRID_COLUMNS);
  }
}

/**
 * Stricter than assertNoTrailingGaps: checks every cell in every occupied
 * row is covered, not just that the rightmost edge reaches column 6. A
 * trailing-only check misses a hole in the *middle* or *start* of a row —
 * exactly the shape of both bugs found while developing this module (see
 * packGrid.ts's doc comment): out-of-order tiers leaving a mid-row hole,
 * and a rowSpan-2 item's second row being left uncovered when its first
 * row got exactly consumed by trailing rowSpan-1 items.
 */
function assertFullOccupancy(items: GridItemInput[], positions: Map<string, { gridColumn: string; gridRow: string }>) {
  const occupied = new Set<string>();
  let maxRow = 0;
  for (const item of items) {
    const pos = positions.get(item.id)!;
    const col = parseSpan(pos.gridColumn);
    const row = parseSpan(pos.gridRow);
    for (let r = row.start; r < row.start + row.span; r++) {
      maxRow = Math.max(maxRow, r);
      for (let c = col.start; c < col.start + col.span; c++) {
        occupied.add(`${r},${c}`);
      }
    }
  }
  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= GRID_COLUMNS; c++) {
      expect(occupied.has(`${r},${c}`), `cell (row ${r}, col ${c}) is unoccupied — a gap, not just a trailing edge`).toBe(true);
    }
  }
}

function assertNoOverlaps(items: GridItemInput[], positions: Map<string, { gridColumn: string; gridRow: string }>) {
  const occupied = new Set<string>();
  for (const item of items) {
    const pos = positions.get(item.id)!;
    const col = parseSpan(pos.gridColumn);
    const row = parseSpan(pos.gridRow);
    for (let r = row.start; r < row.start + row.span; r++) {
      for (let c = col.start; c < col.start + col.span; c++) {
        const key = `${r},${c}`;
        expect(occupied.has(key), `cell ${key} occupied twice`).toBe(false);
        occupied.add(key);
      }
    }
  }
}

/** Runs all three structural assertions at once — the standard bar every packed layout should clear. */
function assertWellFormed(items: GridItemInput[], positions: Map<string, { gridColumn: string; gridRow: string }>) {
  assertNoTrailingGaps(items, positions);
  assertFullOccupancy(items, positions);
  assertNoOverlaps(items, positions);
}

function items(tiers: GridTier[]): GridItemInput[] {
  return tiers.map((tier, i) => ({ id: `card-${i}`, tier }));
}

describe("packGrid", () => {
  it("returns an empty map for no items", () => {
    expect(packGrid([]).size).toBe(0);
  });

  it("places a single hero card and widens it to fill the row", () => {
    const input = items(["hero"]);
    const positions = packGrid(input);
    expect(positions.get("card-0")?.gridColumn).toBe("1 / span 6");
    expect(positions.get("card-0")?.gridRow).toBe("1 / span 2");
  });

  it("widens a large card to close the gap left by hero + large (3 + 2 = 5)", () => {
    const input = items(["hero", "large"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(positions.get("card-1")?.gridColumn).toBe("4 / span 3");
  });

  it("fills a row of two mediums exactly (3+3=6, no widening needed)", () => {
    const input = items(["medium", "medium"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(positions.get("card-0")?.gridColumn).toBe("1 / span 3");
    expect(positions.get("card-1")?.gridColumn).toBe("4 / span 3");
  });

  it("packs a realistic front-page mix (hero, large, large, medium, small, small) with no gaps or overlaps", () => {
    const input = items(["hero", "large", "large", "medium", "small", "small"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(positions.size).toBe(input.length);
  });

  it("packs a realistic topic-page mix (mostly small/medium with one hero) with no gaps or overlaps", () => {
    const input = items(["hero", "small", "small", "small", "medium", "small", "medium", "small"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
  });

  it("closes a lone trailing band the same way as every other band, even with nothing after it", () => {
    // small (card-4) ends up alone in the final band (nothing follows
    // it) — it still gets widened to close its row, exactly like every
    // earlier band, since band-closing isn't deferred or special-cased
    // for the last one.
    const input = items(["hero", "large", "large", "medium", "small"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    const lastCol = parseSpan(positions.get("card-4")!.gridColumn);
    expect(lastCol.span).toBeGreaterThan(TIER_DIMENSIONS.small.colSpan);
  });

  it("closes the mid-row gap found in out-of-order input (a rowSpan-1 tier placed before rowSpan-2 tiers)", () => {
    // Regression test: with items in this literal order (small before
    // two heroes), placing items in input order (without first grouping
    // by tier) put the small in row 1, then the two heroes bled into row
    // 2 in a way that left a 2-column hole nothing could reach. packGrid
    // now stable-sorts by tier before packing specifically to prevent
    // this — same-rowSpan cards are always grouped into their own bands.
    const input = items(["small", "hero", "hero"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
  });

  it.each<[string, GridTier[]]>([
    ["hero + small", ["hero", "small"]],
    ["hero + medium", ["hero", "medium"]],
    ["large + medium", ["large", "medium"]],
    ["large + small", ["large", "small"]],
  ])(
    "closes a rowSpan-2 item's second row even when nothing after it shares that width (%s)",
    (_label, tiers) => {
      // Regression test for a second, distinct bug found during review:
      // even with fully canonical tier order (no out-of-order input),
      // widening whichever item happened to be placed last in a row
      // could still leave a rowSpan-2 item's *second* row uncovered,
      // because a grid item can't be widened on only one of the rows it
      // spans without overlapping content already sitting in the other.
      // The band model sidesteps this structurally: a rowSpan-2 item
      // never shares a row with a rowSpan-1 item at all.
      const input = items(tiers);
      const positions = packGrid(input);
      assertWellFormed(input, positions);
    }
  );

  it("stable-sorts across tiers (hero/large before medium/small) while preserving relative order within a tier", () => {
    const input: GridItemInput[] = [
      { id: "medium-a", tier: "medium" },
      { id: "hero-a", tier: "hero" },
      { id: "medium-b", tier: "medium" },
      { id: "hero-b", tier: "hero" },
    ];
    const positions = packGrid(input);
    const rowOf = (id: string) => parseSpan(positions.get(id)!.gridRow).start;
    const colOf = (id: string) => parseSpan(positions.get(id)!.gridColumn).start;
    const before = (a: string, b: string) => rowOf(a) < rowOf(b) || (rowOf(a) === rowOf(b) && colOf(a) < colOf(b));

    // Both heroes (rowSpan 2) land before both mediums (rowSpan 1),
    // despite the input interleaving them.
    expect(rowOf("hero-a")).toBeLessThanOrEqual(rowOf("medium-a"));
    expect(rowOf("hero-b")).toBeLessThanOrEqual(rowOf("medium-a"));
    // Relative order *within* each tier matches the input order, even
    // though hero-a/hero-b weren't adjacent in the input.
    expect(before("hero-a", "hero-b")).toBe(true);
    expect(before("medium-a", "medium-b")).toBe(true);
  });

  it("never exceeds the 6-column width for any placed item", () => {
    const input = items(["hero", "large", "medium", "small", "small", "hero", "medium"]);
    const positions = packGrid(input);
    for (const item of input) {
      const col = parseSpan(positions.get(item.id)!.gridColumn);
      expect(col.start + col.span - 1).toBeLessThanOrEqual(GRID_COLUMNS);
    }
  });

  it("matches TIER_DIMENSIONS' nominal spans when a band already fills exactly (no widening applied)", () => {
    // large + large + large = 2+2+2 = 6, exact fit, no widening expected.
    const input = items(["large", "large", "large"]);
    const positions = packGrid(input);
    for (const item of input) {
      const col = parseSpan(positions.get(item.id)!.gridColumn);
      expect(col.span).toBe(TIER_DIMENSIONS[item.tier].colSpan);
    }
  });
});
