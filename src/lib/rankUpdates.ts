import type { Card } from "@/types";

export interface RankUpdate {
  id: string;
  frontPageRank: number | null;
}

/**
 * Applies a generation run's front-page rank changes to cards the client is
 * already holding.
 *
 * Needed because rank.ts re-ranks the *cumulative* pool on every run — a
 * second run's bigger story can dethrone the first run's top pick — but the
 * stream only sends back that run's own new cards. Before Phase 8.4 the
 * already-rendered cards kept their stale frontPageRank, so two cards could
 * both hold rank 1 and both render hero-sized until the page was reloaded.
 * The server already computed and persisted these updates
 * (route.ts's existingCardRankUpdates); it just never put them on the wire.
 *
 * `null` is a meaningful value here — it means "demoted off the front page"
 * — so the lookup tests for `undefined` rather than falsiness. A falsy test
 * would silently drop every demotion, which is half the point of this
 * function.
 *
 * Ordering is deliberately not this function's job: both pages derive their
 * order from frontPageRank/severity on every render, so rewriting the field
 * is sufficient and re-sorting here would just be a second source of truth.
 * Cards not mentioned keep their exact object identity, and ids that aren't
 * on this client are ignored rather than treated as an error — a snapshot
 * can legitimately predate a card generated in another tab.
 */
export function applyRankUpdates(cards: Card[], updates: RankUpdate[]): Card[] {
  if (updates.length === 0) return cards;

  const nextRankById = new Map(updates.map((update) => [update.id, update.frontPageRank]));

  return cards.map((card) => {
    const nextRank = nextRankById.get(card.id);
    return nextRank === undefined ? card : { ...card, frontPageRank: nextRank };
  });
}
