import { TIER_DIMENSIONS, type GridTier } from "@/lib/gridTiers";

export const GRID_COLUMNS = 6;

// Sort order for the stable pre-sort below — hero first, then medium, then
// small. See the doc comment for why cards must be grouped by tier before
// packing begins.
const TIER_ORDER: Record<GridTier, number> = { hero: 0, medium: 1, small: 2 };

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
 * leftover gap — which reliably leaves a trailing gap no tier can fill.
 *
 * Two earlier versions of this module tried to fix that with a shared
 * occupancy bitmap across mixed row-heights (hero/large were 2 rows tall,
 * medium/small were 1), widening whichever item happened to be placed last
 * in a row. That approach had two distinct failure modes, both found during
 * this module's own review: (1) a short item placed before a tall item in
 * the input could leave a mid-row hole nothing was ever placed into; (2)
 * even with items in canonical tier order, whenever a tall item's first row
 * got exactly consumed by trailing short items, the tall item's *second*
 * row was left with a hole nothing could close — the short item occupying
 * the same columns one row up can't widen into it without also widening its
 * own row and overlapping content already there. A rectangle can't
 * selectively cover only one of the rows it spans.
 *
 * Both failure modes required *mixing* row-heights within a single band —
 * a taller item and a shorter item both partially occupying the same shared
 * row(s). This version removes that risk at the source, structurally: a
 * band is always a run of consecutive **same-tier** cards (see below), so
 * within any one band every card has identical TIER_DIMENSIONS, including
 * rowSpan — there is no "differently-tall neighbor" inside a band for its
 * second row to be bled into by, regardless of how many distinct rowSpan
 * values exist across the tier table as a whole. Tiers can (and, per
 * gridTiers.ts's actual table, currently do) still differ in height from
 * each other — hero/medium are rowSpan 2, small is rowSpan 1 — that's fine,
 * since it only ever varies *between* bands, never *within* one, and each
 * band's rows are fully closed and exclusive before the next band's rows
 * are touched (see `currentRow += bandRowSpan` below).
 *
 * Cards are stable-sorted into tier order (TIER_ORDER; preserves each
 * card's relative order within its own tier, which is the caller's real
 * importance/tie-break order), then packed into a strict sequence of
 * "bands" — a band is a run of consecutive same-tier cards filling a
 * fresh, exclusive set of rows, closed off (by widening its last card to
 * consume any leftover width) before the next band starts.
 *
 * Band boundaries are keyed on tier *identity*, not row-height — this is a
 * real requirement, not leftover caution: hero must always render alone in
 * its own band, even next to a same-width "medium" card that would
 * otherwise fit in the leftover space. Keying the boundary on rowSpan alone
 * (as an earlier version did) isn't reliable even when rowSpan does vary by
 * tier, and becomes actively wrong whenever two tiers happen to share a
 * rowSpan value (as hero and medium currently do) — it would then be
 * trivially true for any two adjacent cards of either tier and let them
 * merge into one band whenever width allowed. Tier identity is the only
 * signal that reliably tells every tier apart, regardless of how many
 * tiers happen to share a rowSpan value at any given time.
 *
 * Tier identity alone isn't quite enough, though: it stops hero from
 * merging with a *different* tier, but two hero-tier cards next to each
 * other would still pack side-by-side (their nominal widths sum to an
 * exact 6-column fit) unless something caps how many cards a hero band can
 * ever hold. That cap — `maxPerBand: 1` on hero's entry in gridTiers.ts's
 * TIER_DIMENSIONS — is what actually guarantees hero always renders alone,
 * not its width or tier identity by themselves. This matters because two
 * same-topic cards can legitimately both grade to hero-tier severity on
 * the same day (tierForSeverity has no per-topic uniqueness guarantee,
 * unlike the front page's frontPageRank, which rank.ts deduplicates
 * upstream) — found during this module's own review.
 *
 * Trade-off, accepted deliberately: if a day has fewer than the usual count
 * of a given tier (e.g. only 3 "medium" cards instead of the usual 4), the
 * odd one out lands alone in its band and widens to full width — rendering
 * the *same size* as hero (both full-width, both 2 rows), though always
 * positioned in a later row. This is a milder version of an earlier,
 * already-accepted trade-off (previously a lower-ranked card could render
 * *bigger* than hero; now the worst case is *equal*, never bigger, and
 * always later in reading order).
 */
export function packGrid(items: GridItemInput[]): Map<string, GridPosition> {
  // Stable sort: preserves relative order within a tier (already the
  // caller's importance order), only reorders across tiers.
  const ordered = [...items].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);

  const result = new Map<string, GridPosition>();
  let currentRow = 1;
  let i = 0;

  while (i < ordered.length) {
    const bandTier = ordered[i].tier;
    const bandRowSpan = TIER_DIMENSIONS[bandTier].rowSpan;
    const band: { id: string; col: number; colSpan: number }[] = [];
    let col = 1;

    // Fill this band left-to-right with consecutive same-*tier* cards
    // until one doesn't fit the remaining width, the tier changes, or the
    // tier's own maxPerBand cap is reached (see gridTiers.ts's
    // TIER_DIMENSIONS — hero's cap of 1 is what actually guarantees it
    // always renders alone; width alone can't be relied on, since two
    // hero-tier cards' nominal widths sum to an exact 6-column fit and
    // would otherwise pack side-by-side in one band).
    const maxPerBand = TIER_DIMENSIONS[bandTier].maxPerBand ?? Infinity;
    // A tier configured with maxPerBand < 1 would make every band for it
    // start empty, and `band[band.length - 1]` below would be undefined —
    // fail loudly here instead of a confusing crash a few lines down.
    if (maxPerBand < 1) {
      throw new Error(`Invalid maxPerBand for tier "${bandTier}": must be at least 1.`);
    }
    while (i < ordered.length && ordered[i].tier === bandTier && band.length < maxPerBand) {
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
