/**
 * Newspaper box-size tiers for the front page / topic page grids. Four
 * discrete tiers (not continuous sizing) mapped from a card's importance
 * signal — severity (1-5, topic-relative) on topic pages, frontPageRank
 * (1-6, cross-topic) on the front page. Both map onto the same tier table
 * so PageGrid's CSS only ever has to know about four shapes.
 */
export type GridTier = "hero" | "large" | "medium" | "small";

// Tailwind grid-span classes for a 6-column `grid-auto-flow: dense` grid.
export const TIER_SPAN: Record<GridTier, string> = {
  hero: "col-span-3 row-span-2",
  large: "col-span-2 row-span-2",
  medium: "col-span-3 row-span-1",
  small: "col-span-2 row-span-1",
};

/**
 * Topic pages: severity is topic-relative (graded independently per topic,
 * see triage.ts), so a clamp is defensive only — every value triage can
 * actually produce (1-5) already has a tier.
 */
export function tierForSeverity(severity: number): GridTier {
  const clamped = Math.min(5, Math.max(1, Math.round(severity)));
  if (clamped === 5) return "hero";
  if (clamped === 4) return "large";
  if (clamped >= 2) return "medium";
  return "small";
}

/**
 * Front page: frontPageRank is 1-6 (rank.ts caps the front page at 6
 * stories) — a card with no rank (not one of today's picks) has no place on
 * the front page at all, so this function isn't called for it.
 */
export function tierForFrontPageRank(rank: number): GridTier {
  const clamped = Math.min(6, Math.max(1, Math.round(rank)));
  if (clamped === 1) return "hero";
  if (clamped <= 3) return "large";
  if (clamped === 4) return "medium";
  return "small";
}
