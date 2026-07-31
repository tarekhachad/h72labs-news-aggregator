import type { SupabaseClient } from "@supabase/supabase-js";
import type { Card } from "@/types";
import { rowToCard, type CardRow } from "@/lib/digests";

// Postgres unique_violation — see https://www.postgresql.org/docs/current/errcodes-appendix.html
const UNIQUE_VIOLATION = "23505";

/**
 * Which of this user's cards are bookmarked, as a Set for O(1) lookup while
 * annotating a digest's cards with `bookmarked`.
 */
export async function getBookmarkedCardIds(
  supabase: SupabaseClient,
  userId: string
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("bookmarks")
    .select("card_id")
    .eq("user_id", userId);

  if (error) throw new Error(`getBookmarkedCardIds: ${error.message}`);

  return new Set((data ?? []).map((r) => r.card_id as string));
}

/**
 * Idempotent: bookmarking an already-bookmarked card is a no-op success,
 * not an error — a double-click or a stale client retry shouldn't surface
 * as a failure to the user.
 */
export async function addBookmark(
  supabase: SupabaseClient,
  userId: string,
  cardId: string
): Promise<{ error: string | null }> {
  // The `bookmarks` insert RLS policy only checks that user_id = auth.uid()
  // — it says nothing about whether cardId is actually one of this user's
  // own cards. Reusing the `cards` table's own select RLS (scoped to rows
  // reachable via the caller's own digests) as an ownership check closes
  // that gap: a card id that exists but belongs to someone else looks
  // identical to one that doesn't exist at all, so this can't be used to
  // probe for other users' card ids either.
  const { data: card, error: cardError } = await supabase
    .from("cards")
    .select("id")
    .eq("id", cardId)
    .maybeSingle();

  if (cardError) return { error: "Couldn't bookmark this card — try again." };
  if (!card) return { error: "Card not found." };

  const { error } = await supabase
    .from("bookmarks")
    .insert({ user_id: userId, card_id: cardId });

  if (error && error.code !== UNIQUE_VIOLATION) {
    return { error: "Couldn't bookmark this card — try again." };
  }
  return { error: null };
}

export async function removeBookmark(
  supabase: SupabaseClient,
  userId: string,
  cardId: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("bookmarks")
    .delete()
    .eq("user_id", userId)
    .eq("card_id", cardId);

  if (error) {
    return { error: "Couldn't remove this bookmark — try again." };
  }
  return { error: null };
}

interface SavedCardRow extends CardRow {
  digests: { date: string } | null;
}

export interface SavedCard extends Card {
  /** The calendar date the card's digest belongs to — for context in the Saved view. */
  date: string;
}

/**
 * This user's bookmarked cards, most recently bookmarked first — per
 * docs/(C) DATABASE_SCHEMA.md's note that bookmarks.created_at exists
 * specifically to sort this view. No content is duplicated here; this
 * joins through to the card's (and its digest's) permanent row.
 */
export async function getSavedCards(
  supabase: SupabaseClient,
  userId: string
): Promise<SavedCard[]> {
  const { data, error } = await supabase
    .from("bookmarks")
    .select(
      "cards(id, topic, short_summary, expanded_report, sources, published_at, digests(date))"
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getSavedCards: ${error.message}`);

  return (data ?? [])
    .map((row) => row.cards as unknown as SavedCardRow | null)
    // Defensive: on delete cascade means an orphaned bookmark shouldn't
    // exist, but a missing joined card should never crash this page.
    .filter((card): card is SavedCardRow => card !== null)
    .map((card) => ({
      // Every card reachable from getSavedCards is bookmarked by
      // construction — no need to look it up, unlike rowToCard's normal
      // callers which annotate a mixed set of cards.
      ...rowToCard(card, new Set([card.id])),
      date: card.digests?.date ?? "",
    }));
}
