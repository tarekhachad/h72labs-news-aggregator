import type { Cluster, Source } from "@/types";

/**
 * The reader's picked outlets, as every pipeline stage reads them.
 *
 * One definition shared by triage's boost, the card cap, the front-page
 * ranker and the card writer, so "this story has N of your sources" means
 * the same thing at every stage. A picked outlet is a soft preference, never
 * a filter: nothing here removes an article or a story.
 *
 * Every helper takes the list as optional and treats absent and empty the
 * same way, which is what makes "zero preferences reproduces today's
 * behaviour exactly" a property of this module rather than of each caller.
 */
export type PreferredSources = readonly Source[] | undefined;

/** The most a triage severity can be (triage grades 1-5). */
export const MAX_SEVERITY = 5;

/** How much a picked outlet adds to a judged-notable cluster's severity. */
export const PREFERRED_SEVERITY_BOOST = 1;

/**
 * How many DISTINCT preferred outlets carried the story.
 *
 * Outlets, not articles: two BBC pieces on one story are one preferred
 * source, so a story can't outrank another just because one outlet filed it
 * twice. This is the count the card cap and the ranker compare.
 */
export function countPreferredSources(
  items: readonly { source: Source }[],
  preferred: PreferredSources
): number {
  if (!preferred || preferred.length === 0) return 0;
  const picked = new Set<Source>(preferred);
  const seen = new Set<Source>();
  for (const item of items) {
    // Optional chaining because a card's stored source list is read back
    // from the database, and a malformed entry there must count as nothing
    // rather than throw after the run's cards were already paid for.
    if (picked.has(item?.source)) seen.add(item.source);
  }
  return seen.size;
}

/**
 * Preferred outlets first, everything else after, each group in its
 * original relative order.
 *
 * Always returns a new array, so a caller can't mutate the input through it.
 * With no preferences, or none present, the result is element-for-element
 * the input.
 */
export function orderPreferredFirst<T extends { source: Source }>(
  items: readonly T[],
  preferred: PreferredSources
): T[] {
  if (!preferred || preferred.length === 0) return [...items];
  const picked = new Set<Source>(preferred);
  return [
    ...items.filter((item) => picked.has(item.source)),
    ...items.filter((item) => !picked.has(item.source)),
  ];
}

/**
 * Raises the severity of every judged-notable cluster that at least one
 * preferred outlet covered, by PREFERRED_SEVERITY_BOOST, capped at
 * MAX_SEVERITY. Applied after triage and before the card cap.
 *
 * Only `notable` clusters qualify. A rejected cluster's severity is
 * meaningless (triage returns 1 for every reject), and a fail-closed cluster
 * is one triage never judged at all: lifting either would write up a story
 * nothing vetted, at Sonnet prices. The boost reorders what triage passed;
 * it never overrides a "no".
 *
 * A boosted item keeps triage's own grade as `triageSeverity`. The cap at 5
 * flattens a triage 4 and a triage 5 into the same 5; the card cap breaks
 * that tie on `triageSeverity`, so the boost lifts a story past unboosted
 * ones but never reorders two stories that both received it.
 *
 * Returns new item objects rather than mutating the input, and `boosted`
 * counts the clusters that qualified, including any already at the cap.
 */
export function boostPreferredClusters<
  T extends { cluster: Cluster; notable: boolean; severity: number },
>(
  triaged: readonly T[],
  preferred: PreferredSources
): { items: (T & { triageSeverity?: number })[]; boosted: number } {
  if (!preferred || preferred.length === 0) return { items: [...triaged], boosted: 0 };
  let boosted = 0;
  const items = triaged.map((item): T & { triageSeverity?: number } => {
    if (!item.notable || countPreferredSources(item.cluster.articles, preferred) === 0) {
      return item;
    }
    boosted += 1;
    return {
      ...item,
      severity: Math.min(MAX_SEVERITY, item.severity + PREFERRED_SEVERITY_BOOST),
      triageSeverity: item.severity,
    };
  });
  return { items, boosted };
}
