import type { Card } from "@/types";

/**
 * The ids of cards belonging to the most recent generation run *on this
 * page* — or an empty set when every card on the page came from the same
 * run, since "new" only means anything relative to something older.
 *
 * This is what replaced Phase 5.7's run dividers (Phase 8.4). The divider
 * consumed a full grid row and, because ranking is cumulative across the
 * day, runs interleave by importance rather than stacking into contiguous
 * blocks — so two runs could produce three separators. Marking individual
 * cards instead leaves the importance ordering completely untouched and
 * costs no layout at all.
 *
 * Scoped to the cards the caller actually renders, not to the whole day.
 * A second run that wins no front-page slots correctly badges nothing
 * there, while still badging its cards on their own topic page.
 *
 * Runs are keyed on Date.parse(generatedAt), not on the raw string.
 * `generatedAt` reaches the client through two different serializers:
 * PostgREST's timestamptz rendering via rowToCard ("…10:00:00.123+00:00")
 * for anything read from the database, and route.ts's own
 * new Date().toISOString() ("…10:00:00.123Z") for cards streamed live from
 * a generation in progress. Those are the same instant written two ways,
 * so string comparison would see two runs where there is one. Normalizing
 * to epoch milliseconds makes both the grouping and the "which is latest"
 * decision independent of which path a card arrived by. (With today's data
 * a naive string compare happens to work, because a page never mixes the
 * two forms for the same run — this is robustness against that changing,
 * not a bug being fixed.)
 *
 * Unparseable values are ignored rather than treated as their own run, so
 * one malformed row can't invent a second run and badge the whole page.
 */
export function newRunCardIds(cards: Card[]): Set<string> {
  const stamped = cards
    .map((card) => ({ id: card.id, at: Date.parse(card.generatedAt) }))
    .filter((card) => Number.isFinite(card.at));

  const distinctRuns = new Set(stamped.map((card) => card.at));
  if (distinctRuns.size < 2) return new Set();

  const latest = Math.max(...distinctRuns);
  return new Set(stamped.filter((card) => card.at === latest).map((card) => card.id));
}
