/**
 * Newspaper box-size tiers for the front page / topic page grids. Three
 * discrete tiers (not continuous sizing) mapped from a card's importance
 * signal — severity (1-5, topic-relative) on topic pages, frontPageRank
 * (1-6, cross-topic) on the front page. Both map onto the same tier table
 * so PageGrid's CSS only ever has to know about three shapes.
 *
 * Hero and medium are the same row-height (rowSpan 2 / 360px); small is a
 * single row (rowSpan 1 / 180px) — confirmed exactly by Tarek: hero alone
 * at full width and double height; the next tier (ranks/severities just
 * below hero) pairs up, sharing width, still at double height; everything
 * below that packs at single-row height. Previously a fourth tier ("large")
 * was the same width as hero but the same height as medium/small, which let
 * a lone "large" card (nothing else to share its row with that day) get
 * widened to hero's full width AND full height — visually as prominent as
 * the actual #1 story. Removed rather than special-cased. Mixing hero/
 * medium's rowSpan 2 with small's rowSpan 1 doesn't reopen that risk: a
 * band is always 100% one tier (see packGrid.ts's tier-identity rule), so
 * small never shares rows with hero/medium regardless of its own height.
 */
export type GridTier = "hero" | "medium" | "small";

// Column/row spans for a 6-column grid. Consumed by packGrid.ts to compute
// each card's explicit grid position (see that file for why explicit
// placement replaced CSS `grid-auto-flow: dense`) — a tier's colSpan here
// is its *nominal* width; packGrid may widen a specific card's rendered
// span beyond this to close a band, so this table is an input to layout,
// not the final rendered span. hero's nominal value (3, not 6) is
// deliberate: hero goes through the exact same "nominal width, widened to
// close its band" path as every other lone-in-a-band tier, rather than
// being hardcoded to its final rendered width as a special case.
//
// `maxPerBand` caps how many cards of that tier packGrid.ts will ever pack
// into one band, regardless of remaining width — hero's `1` is what
// actually guarantees it always renders alone, not its width. This has to
// be an explicit, table-driven constraint rather than something inferred
// from caller behavior: tierForFrontPageRank's input (frontPageRank) is
// deduplicated upstream by rank.ts, so it happens to only ever produce one
// hero card — but tierForSeverity has no such uniqueness guarantee
// (severity is graded independently per cluster), so two same-topic cards
// could legitimately both land on "hero" some day. Putting the cap here,
// next to the tier's other properties, makes the constraint visible to
// anyone editing this table — a future tier needing the same "always
// alone" treatment just sets its own `maxPerBand`, rather than needing to
// know to go add a special case inside packGrid.ts's loop body.
export const TIER_DIMENSIONS: Record<GridTier, { colSpan: number; rowSpan: number; maxPerBand?: number }> = {
  hero: { colSpan: 3, rowSpan: 2, maxPerBand: 1 },
  medium: { colSpan: 3, rowSpan: 2 },
  small: { colSpan: 2, rowSpan: 1 },
};

/**
 * Topic pages: severity is topic-relative (graded independently per topic,
 * see triage.ts), so a clamp is defensive only — every value triage can
 * actually produce (1-5) already has a tier. Breakpoints are a proposal
 * (Tarek confirmed the same hero/medium/small philosophy as the front page
 * but didn't specify exact severity cutoffs) — easy to adjust.
 */
export function tierForSeverity(severity: number): GridTier {
  const clamped = Math.min(5, Math.max(1, Math.round(severity)));
  if (clamped === 5) return "hero";
  if (clamped >= 3) return "medium"; // 3-4
  return "small"; // 1-2
}

/**
 * Front page: frontPageRank is 1-6 (rank.ts caps the front page at 6
 * stories) — a card with no rank (not one of today's picks) has no place on
 * the front page at all, so this function isn't called for it. Breakpoints
 * confirmed exactly by Tarek: rank 1 alone (hero); ranks 2-5 pair up two
 * per band under the normal 4-medium count; rank 6 (and beyond, if the cap
 * ever changes) packs separately at the narrower small width.
 */
export function tierForFrontPageRank(rank: number): GridTier {
  const clamped = Math.min(6, Math.max(1, Math.round(rank)));
  if (clamped === 1) return "hero";
  if (clamped <= 5) return "medium"; // 2-5
  return "small"; // 6
}
