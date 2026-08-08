import { describe, it, expect } from "vitest";
import { packGrid, packGridWithRunDividers, GRID_COLUMNS, type GridItemInput } from "@/lib/packGrid";
import { TIER_DIMENSIONS, type GridTier } from "@/lib/gridTiers";

function parseSpan(value: string): { start: number; span: number } {
  const [start, , , span] = value.split(" ");
  return { start: Number(start), span: Number(span) };
}

/**
 * Asserts the packed layout has no row that ends with unfilled trailing
 * width — the original bug class packGrid exists to fix. Walks every
 * occupied row and checks the rightmost occupied column reaches the full
 * 6-column width.
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
 * row is covered, not just that the rightmost edge reaches column 6 — a
 * trailing-only check missed real bugs found in earlier versions of this
 * module (a mid-row hole from out-of-order input; a tall item's second row
 * left uncovered when mixed row-heights were still possible). Both of
 * those specific mechanisms are now structurally impossible — not because
 * every tier shares one rowSpan (they don't; hero/medium are 2 rows, small
 * is 1), but because every band is single-tier by construction, so within
 * any one band every card shares the same rowSpan regardless of what other
 * tiers exist (see packGrid.ts's doc comment). This check stays as the
 * real bar any packed layout should clear, including a genuinely
 * mixed-row-height page.
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

function rowStart(positions: Map<string, { gridColumn: string; gridRow: string }>, id: string): number {
  return parseSpan(positions.get(id)!.gridRow).start;
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

  it("keeps hero alone even when the very next card is the same width (medium)", () => {
    // hero (colSpan 3 nominal) + medium (colSpan 3) sum to exactly 6 — the
    // old rowSpan-only band boundary would have happily merged them into
    // one band. Tier-identity banding must keep them apart regardless.
    const input = items(["hero", "medium"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(rowStart(positions, "card-0")).not.toBe(rowStart(positions, "card-1"));
    expect(positions.get("card-0")?.gridColumn).toBe("1 / span 6");
  });

  it("keeps hero alone even with two mediums present", () => {
    const input = items(["hero", "medium", "medium"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    const heroRow = rowStart(positions, "card-0");
    expect(rowStart(positions, "card-1")).not.toBe(heroRow);
    expect(rowStart(positions, "card-2")).not.toBe(heroRow);
  });

  it("packs a realistic full front page: hero alone, then two medium pairs, then a lone small", () => {
    // Mirrors tierForFrontPageRank's exact breakpoints: rank 1 = hero,
    // ranks 2-5 = medium (4 of them, pairing two per band), rank 6 = small.
    const input = items(["hero", "medium", "medium", "medium", "medium", "small"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);

    const heroRow = rowStart(positions, "card-0");
    const pair1Row = rowStart(positions, "card-1");
    const pair2Row = rowStart(positions, "card-3");
    const smallRow = rowStart(positions, "card-5");

    // card-1/card-2 (ranks 2-3) share a band; card-3/card-4 (ranks 4-5)
    // share a second, different band.
    expect(rowStart(positions, "card-2")).toBe(pair1Row);
    expect(rowStart(positions, "card-4")).toBe(pair2Row);
    // All four bands are distinct rows, in reading order.
    expect(new Set([heroRow, pair1Row, pair2Row, smallRow]).size).toBe(4);
    expect(heroRow).toBeLessThan(pair1Row);
    expect(pair1Row).toBeLessThan(pair2Row);
    expect(pair2Row).toBeLessThan(smallRow);
    // The two medium pairs are exact fits (3+3=6) — no widening.
    expect(parseSpan(positions.get("card-1")!.gridColumn).span).toBe(TIER_DIMENSIONS.medium.colSpan);
  });

  it("isolates an odd leftover medium into its own full-width band, without merging into the small band", () => {
    // Core regression test: an odd (3, not the usual 4) count of medium
    // cards leaves one alone. It must widen to full width like hero (the
    // known, accepted edge case — see packGrid.ts's doc comment) but must
    // NOT merge with the following small card, even though 3+2=5 <= 6
    // would technically fit width-wise.
    const input = items(["hero", "medium", "medium", "medium", "small"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);

    const heroRow = rowStart(positions, "card-0");
    const pairRow = rowStart(positions, "card-1");
    const loneRow = rowStart(positions, "card-3");
    const smallRow = rowStart(positions, "card-4");

    expect(rowStart(positions, "card-2")).toBe(pairRow); // card-1/card-2 pair up
    expect(loneRow).not.toBe(smallRow); // the lone medium never merges with small
    expect(new Set([heroRow, pairRow, loneRow, smallRow]).size).toBe(4);
    // The lone medium widens to full width, same rendered size as hero.
    expect(positions.get("card-3")?.gridColumn).toBe("1 / span 6");
    expect(positions.get("card-0")?.gridColumn).toBe("1 / span 6");
  });

  it.each<[string, GridTier[]]>([
    ["hero + small", ["hero", "small"]],
    ["hero + medium", ["hero", "medium"]],
    ["medium + small", ["medium", "small"]],
  ])("never merges two different tiers into one band, even when combined width would fit (%s)", (_label, tiers) => {
    const input = items(tiers);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(rowStart(positions, "card-0")).not.toBe(rowStart(positions, "card-1"));
  });

  it("packs three small cards exactly (2+2+2=6), no widening needed", () => {
    const input = items(["small", "small", "small"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    for (const item of input) {
      const col = parseSpan(positions.get(item.id)!.gridColumn);
      expect(col.span).toBe(TIER_DIMENSIONS.small.colSpan);
    }
  });

  it("gives hero and medium double-row height but small a single row, mixed within one page", () => {
    // Regression test for the corrected design: hero/medium are 2 rows
    // tall, small is 1 row tall — a real mix of row-heights across bands
    // (never within one, per the tier-identity rule) that must render
    // correctly, not just be gap-free.
    const input = items(["hero", "medium", "medium", "small", "small", "small"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(parseSpan(positions.get("card-0")!.gridRow).span).toBe(2); // hero
    expect(parseSpan(positions.get("card-1")!.gridRow).span).toBe(2); // medium
    expect(parseSpan(positions.get("card-3")!.gridRow).span).toBe(1); // small
    expect(parseSpan(positions.get("card-4")!.gridRow).span).toBe(1); // small
  });

  it("closes a lone trailing band the same way as every other band, even with nothing after it", () => {
    const input = items(["hero", "small"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(positions.get("card-1")?.gridColumn).toBe("1 / span 6");
  });

  it("groups cards by tier via the stable pre-sort, regardless of input order", () => {
    // Regression test: cards are always sorted by tier before packing, so
    // literal input order (small before two mediums here) doesn't affect
    // the final grouping — both mediums end up sharing one band, small
    // gets its own, no gaps anywhere.
    const input = items(["small", "medium", "medium"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(rowStart(positions, "card-1")).toBe(rowStart(positions, "card-2")); // both mediums, same band
    expect(rowStart(positions, "card-0")).not.toBe(rowStart(positions, "card-1")); // small separate
  });

  it("never lets two hero-tier cards share a band, even though their combined width would fit exactly", () => {
    // hero's nominal colSpan is 3, so two heroes side by side would sum to
    // exactly 6 — a tempting "exact fit" the old rowSpan-only boundary
    // check (and tier-identity alone) can't reject on width grounds.
    // Reachable in practice: tierForSeverity has no per-topic uniqueness
    // guarantee (unlike frontPageRank), so two clusters on the same topic
    // could both grade to severity 5 → both map to "hero" the same day.
    const input = items(["hero", "hero"]);
    const positions = packGrid(input);
    assertWellFormed(input, positions);
    expect(rowStart(positions, "card-0")).not.toBe(rowStart(positions, "card-1"));
    expect(positions.get("card-0")?.gridColumn).toBe("1 / span 6");
    expect(positions.get("card-1")?.gridColumn).toBe("1 / span 6");
  });

  it("stable-sorts across tiers (hero before medium) while preserving relative order within a tier", () => {
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

    expect(rowOf("hero-a")).toBeLessThanOrEqual(rowOf("medium-a"));
    expect(rowOf("hero-b")).toBeLessThanOrEqual(rowOf("medium-a"));
    // Relative order *within* each tier matches the input order, even
    // though hero-a/hero-b weren't adjacent in the input.
    expect(before("hero-a", "hero-b")).toBe(true);
    expect(before("medium-a", "medium-b")).toBe(true);
  });

  it("never exceeds the 6-column width for any placed item", () => {
    const input = items(["hero", "medium", "small", "small", "hero", "medium"]);
    const positions = packGrid(input);
    for (const item of input) {
      const col = parseSpan(positions.get(item.id)!.gridColumn);
      expect(col.start + col.span - 1).toBeLessThanOrEqual(GRID_COLUMNS);
    }
  });

  describe("breakBefore (5.7 run dividers)", () => {
    it("reserves one extra row of separation when a mid-tier item sets breakBefore", () => {
      // Four mediums (colSpan 3 each) already pack as two pairs sharing two
      // adjacent bands with zero gap between them (see the "realistic full
      // front page" test above). Marking breakBefore on card-2 — the first
      // card of the second pair, which would otherwise sit immediately
      // after the first pair's band — must open up exactly one extra
      // reserved row above it for the divider, on top of that existing
      // band boundary.
      const input: GridItemInput[] = [
        { id: "card-0", tier: "medium" },
        { id: "card-1", tier: "medium" },
        { id: "card-2", tier: "medium", breakBefore: true },
        { id: "card-3", tier: "medium" },
      ];
      const withoutBreak = packGrid(input.map((it) => ({ id: it.id, tier: it.tier })));
      const withBreak = packGrid(input);

      // Baseline (no break): the two pairs are adjacent bands, no gap.
      const baselineRow01 = rowStart(withoutBreak, "card-0");
      const baselineRow23 = rowStart(withoutBreak, "card-2");
      expect(baselineRow23).toBe(baselineRow01 + TIER_DIMENSIONS.medium.rowSpan);

      // With the break: card-0/card-1 are one band, card-2/card-3 a second,
      // now separated by one *additional* reserved row (the divider's row)
      // beyond the baseline's own band boundary.
      const row01 = rowStart(withBreak, "card-0");
      const row23 = rowStart(withBreak, "card-2");
      expect(rowStart(withBreak, "card-1")).toBe(row01);
      expect(rowStart(withBreak, "card-3")).toBe(row23);
      expect(row23).toBe(row01 + TIER_DIMENSIONS.medium.rowSpan + 1); // +1 reserved divider row
    });

    it("ignores a stray breakBefore on the very first item — no wasted leading row", () => {
      const input: GridItemInput[] = [
        { id: "card-0", tier: "hero", breakBefore: true },
        { id: "card-1", tier: "medium" },
      ];
      const positions = packGrid(input);
      expect(rowStart(positions, "card-0")).toBe(1); // not 2
    });

    it("handles back-to-back single-card runs — one reserved row per boundary", () => {
      const input: GridItemInput[] = [
        { id: "card-0", tier: "small" },
        { id: "card-1", tier: "small", breakBefore: true },
        { id: "card-2", tier: "small", breakBefore: true },
      ];
      const positions = packGrid(input);
      const row0 = rowStart(positions, "card-0");
      const row1 = rowStart(positions, "card-1");
      const row2 = rowStart(positions, "card-2");
      expect(row1).toBe(row0 + TIER_DIMENSIONS.small.rowSpan + 1);
      expect(row2).toBe(row1 + TIER_DIMENSIONS.small.rowSpan + 1);
    });

    it("still widens a band split by breakBefore to fill full width, no trailing gaps", () => {
      const input: GridItemInput[] = [
        { id: "card-0", tier: "medium" },
        { id: "card-1", tier: "medium", breakBefore: true },
      ];
      const positions = packGrid(input);
      expect(positions.get("card-0")?.gridColumn).toBe("1 / span 6");
      expect(positions.get("card-1")?.gridColumn).toBe("1 / span 6");
    });
  });
});

describe("packGridWithRunDividers", () => {
  function runCards(
    entries: { tier: GridTier; generatedAt: string }[]
  ): { id: string; tier: GridTier; generatedAt: string }[] {
    return entries.map((e, i) => ({ id: `card-${i}`, ...e }));
  }

  it("produces no dividers when every card shares one generatedAt (the common single-generation case)", () => {
    const cards = runCards([
      { tier: "hero", generatedAt: "2026-08-08T10:00:00.000Z" },
      { tier: "medium", generatedAt: "2026-08-08T10:00:00.000Z" },
      { tier: "medium", generatedAt: "2026-08-08T10:00:00.000Z" },
    ]);
    const { dividers, gridPositions } = packGridWithRunDividers(cards);
    expect(dividers).toHaveLength(0);
    expect(gridPositions.size).toBe(3);
  });

  it("inserts exactly one divider at a single run boundary, positioned one row above the next run's first card", () => {
    const cards = runCards([
      { tier: "hero", generatedAt: "2026-08-08T10:00:00.000Z" },
      { tier: "medium", generatedAt: "2026-08-08T12:30:00.000Z" },
      { tier: "medium", generatedAt: "2026-08-08T12:30:00.000Z" },
    ]);
    const { dividers, gridPositions } = packGridWithRunDividers(cards);
    expect(dividers).toHaveLength(1);
    expect(dividers[0].generatedAt).toBe("2026-08-08T12:30:00.000Z");

    const dividerRow = Number(dividers[0].gridPosition.gridRow.split(" ")[0]);
    const nextCardRow = Number(gridPositions.get("card-1")!.gridRow.split(" ")[0]);
    expect(dividerRow).toBe(nextCardRow - 1);
    expect(dividers[0].gridPosition.gridColumn).toBe(`1 / span ${GRID_COLUMNS}`);
  });

  it("inserts multiple dividers when runs interleave by importance order (rank.ts dethroning a card from an earlier run)", () => {
    // Simulates a later run's card outranking an earlier run's card, so
    // after sorting by importance the two runs interleave rather than
    // stacking as clean contiguous blocks — an accepted, real consequence
    // documented on packGridWithRunDividers itself.
    const cards = runCards([
      { tier: "medium", generatedAt: "run-1" },
      { tier: "medium", generatedAt: "run-2" },
      { tier: "medium", generatedAt: "run-1" },
      { tier: "medium", generatedAt: "run-2" },
    ]);
    const { dividers } = packGridWithRunDividers(cards);
    expect(dividers).toHaveLength(3); // boundary before every card after the first

    // The same run's generatedAt legitimately backs more than one divider
    // here (run-2 appears at both the 2nd and 4th boundary) — this is
    // exactly why callers must key their <RunDivider> elements on
    // something other than generatedAt: a fewer-unique-values-than-length
    // check pins down the precondition that made the real key-collision
    // bug (found live via React's own duplicate-key warning) reachable.
    const uniqueGeneratedAts = new Set(dividers.map((d) => d.generatedAt));
    expect(uniqueGeneratedAts.size).toBeLessThan(dividers.length);

    // gridPosition.gridRow (what FrontPage.tsx/TopicPage.tsx actually key
    // on) stays unique per divider even in this exact collision-prone
    // scenario — the assertion above only proves generatedAt was unsafe to
    // key on; this one proves the actual fix's replacement key is safe.
    const uniqueGridRows = new Set(dividers.map((d) => d.gridPosition.gridRow));
    expect(uniqueGridRows.size).toBe(dividers.length);
  });

  it("every card still gets a valid, non-overlapping position alongside the reserved divider rows", () => {
    const cards = runCards([
      { tier: "hero", generatedAt: "run-1" },
      { tier: "medium", generatedAt: "run-1" },
      { tier: "medium", generatedAt: "run-1" },
      { tier: "medium", generatedAt: "run-2" },
      { tier: "medium", generatedAt: "run-2" },
      { tier: "small", generatedAt: "run-2" },
    ]);
    const { gridPositions, dividers } = packGridWithRunDividers(cards);
    expect(gridPositions.size).toBe(6);
    expect(dividers).toHaveLength(1); // one boundary: run-1 block, then run-2 block

    // No card row collides with a divider's own reserved row.
    const dividerRows = new Set(dividers.map((d) => Number(d.gridPosition.gridRow.split(" ")[0])));
    for (const pos of gridPositions.values()) {
      const start = Number(pos.gridRow.split(" ")[0]);
      const span = Number(pos.gridRow.split(" ")[3]);
      for (let r = start; r < start + span; r++) {
        expect(dividerRows.has(r)).toBe(false);
      }
    }
  });

  it("computes breakBefore against tier-sorted adjacency, not raw input order — no invalid divider row", () => {
    // Regression test: both real callers (FrontPage.tsx/TopicPage.tsx)
    // happen to pass cards already sorted by a field monotonic with tier
    // (frontPageRank / severity), so this never manifests today — but
    // this input deliberately violates that assumption (medium before
    // hero) to prove the function doesn't silently depend on it. Before
    // the fix, breakBefore was computed against *this* raw order, then
    // packGrid's own internal tier-sort moved the hero card to the front
    // — landing it at row 1 with no reservation despite believing it had
    // one, producing an invalid `"0 / span 1"` divider row.
    const cards = runCards([
      { tier: "medium", generatedAt: "run-1" },
      { tier: "hero", generatedAt: "run-2" }, // reordered to the front by tier-sort
    ]);
    const { gridPositions, dividers } = packGridWithRunDividers(cards);

    expect(dividers).toHaveLength(1);
    const dividerRow = Number(dividers[0].gridPosition.gridRow.split(" ")[0]);
    expect(dividerRow).toBeGreaterThanOrEqual(1); // never row 0 or negative

    // The divider sits directly above whichever card landed second in
    // packing order (medium, since hero sorts first) — not above hero,
    // which is genuinely first once tier-sorted and gets no reservation.
    const mediumCardId = cards.find((c) => c.tier === "medium")!.id;
    const mediumRow = Number(gridPositions.get(mediumCardId)!.gridRow.split(" ")[0]);
    expect(dividerRow).toBe(mediumRow - 1);
  });
});
