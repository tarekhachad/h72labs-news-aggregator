import { TIER_DIMENSIONS, type GridTier } from "@/lib/gridTiers";

export const GRID_COLUMNS = 6;

// hero/large (rowSpan 2) are grouped and placed before medium/small
// (rowSpan 1) — see the doc comment below on why mixing rowSpans within a
// band isn't safe.
const TIER_ORDER: Record<GridTier, number> = { hero: 0, large: 1, medium: 2, small: 3 };

export interface GridItemInput {
  id: string;
  tier: GridTier;
}

export interface GridPosition {
  gridColumn: string;
  gridRow: string;
}

/**
 * Computes explicit grid-column/grid-row placement for a sequence of cards,
 * replacing CSS `grid-auto-flow: dense` (see PageGrid.tsx). `dense` reorders
 * later items into exact-fit gaps but never resizes an item to close a
 * leftover gap — which reliably leaves a trailing gap no tier can fill
 * whenever a row-span-2 tier (hero/large) only partially fills its two-row
 * band, since the narrowest tier is 2 columns wide and nothing smaller can
 * ever close a 1-column hole.
 *
 * An earlier version of this module tried to fix that by placing items
 * left-to-right (a shared occupancy bitmap across mixed row-spans) and
 * widening whichever item happened to be placed last in a row. That
 * approach turned out to have two distinct failure modes, both found
 * during this module's own review: (1) a rowSpan-1 item placed before a
 * rowSpan-2 item in the input could leave a mid-row hole nothing was ever
 * ITEM-placed into, since the row-closing logic only widens the last item
 * *actually placed* in a row; (2) even with items in canonical tier order,
 * whenever a rowSpan-2 item's first row got exactly consumed by trailing
 * rowSpan-1 items, that rowSpan-2 item's *second* row was left with a hole
 * nothing could close — the only item that could have widened into it
 * (the rowSpan-1 item occupying the same columns one row up) can't, because
 * widening a grid item changes its width on *every* row it spans, and that
 * would overlap the row-1 content already sitting in that space. A
 * rectangle can't selectively cover only its second row.
 *
 * This version sidesteps both failure modes structurally instead of
 * special-casing them: cards are first stable-sorted into tier order
 * (hero/large before medium/small — see TIER_ORDER; preserves each card's
 * relative order within its own tier, which is the caller's real
 * importance/tie-break order), then packed into a strict sequence of
 * "bands" — a band is a run of same-rowSpan cards filling a fresh set of
 * rows, closed off (by widening its last card to consume any leftover
 * width) before the next band starts. Because a band never shares a row
 * with a different-rowSpan band, there is no cross-rowSpan bleed-through to
 * create an unreachable hole in the first place — every band is either an
 * exact fit or gets widened to one, and that's the whole guarantee. The
 * trade-off, accepted deliberately: cards of different row-heights can no
 * longer visually interlock within the same physical row the way the old
 * bitmap approach sometimes did — every hero/large row-band is fully
 * separate from every medium/small row-band. Full-width correctness is the
 * mandatory requirement (see the roadmap's 5.1 entry); a denser interlocking
 * layout, if wanted later, is a different and harder problem.
 */
export function packGrid(items: GridItemInput[]): Map<string, GridPosition> {
  // Stable sort: preserves relative order within a tier (already the
  // caller's importance order), only reorders across tiers.
  const ordered = [...items].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

  const result = new Map<string, GridPosition>();
  let currentRow = 1;
  let i = 0;

  while (i < ordered.length) {
    const bandRowSpan = TIER_DIMENSIONS[ordered[i].tier].rowSpan;
    const band: { id: string; col: number; colSpan: number }[] = [];
    let col = 1;

    // Fill this band left-to-right with consecutive same-rowSpan cards
    // until one doesn't fit the remaining width or the rowSpan changes
    // (a fresh band starts on the next iteration of the outer loop).
    while (i < ordered.length && TIER_DIMENSIONS[ordered[i].tier].rowSpan === bandRowSpan) {
      const { colSpan } = TIER_DIMENSIONS[ordered[i].tier];
      if (col + colSpan - 1 > GRID_COLUMNS) break;
      band.push({ id: ordered[i].id, col, colSpan });
      col += colSpan;
      i++;
    }

    // Close the band: widen the last card to consume any leftover width.
    // Always safe — nothing else will ever be placed in this band's rows,
    // since every subsequent card either belongs to this same still-open
    // band (already consumed above) or starts an entirely fresh band.
    const last = band[band.length - 1];
    const leftover = GRID_COLUMNS - (last.col + last.colSpan - 1);
    if (leftover > 0) last.colSpan += leftover;

    for (const placedItem of band) {
      result.set(placedItem.id, {
        gridColumn: `${placedItem.col} / span ${placedItem.colSpan}`,
        gridRow: `${currentRow} / span ${bandRowSpan}`,
      });
    }
    currentRow += bandRowSpan;
  }

  return result;
}
