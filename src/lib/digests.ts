import type { SupabaseClient } from "@supabase/supabase-js";
import type { Card, Digest, Topic } from "@/types";
import { getBookmarkedCardIds } from "@/lib/bookmarks";

const UNIQUE_VIOLATION = "23505";

export interface CardRow {
  id: string;
  topic: string;
  short_summary: string;
  expanded_report: string | null;
  sources: Card["sources"];
  published_at: string;
}

/** Shared DB-row -> Card mapper — also used by bookmarks.ts's getSavedCards
 * so the two don't hand-roll the same field mapping independently. */
export function rowToCard(row: CardRow, bookmarkedIds: Set<string>): Card {
  return {
    id: row.id,
    topic: row.topic as Topic,
    shortSummary: row.short_summary,
    expandedReport: row.expanded_report,
    sources: row.sources,
    publishedAt: row.published_at,
    bookmarked: bookmarkedIds.has(row.id),
  };
}

// The digest "date" is a UTC calendar day, not the visiting user's local
// day — a deliberate v1 simplification (this app has no per-user timezone
// setting yet). A user near a day boundary may see "today" roll over a few
// hours off from their own midnight; acceptable for a personal reader used
// by Tarek and a handful of friends, revisit if it becomes a real complaint.
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A user's digest for a specific calendar date, with its cards (most recent
 * source coverage first) — or null if nothing's been generated for that
 * date yet. Used for both "today" (the home page) and a specific past date
 * (the history day view).
 */
export async function getDigestForDate(
  supabase: SupabaseClient,
  userId: string,
  date: string
): Promise<Digest | null> {
  const { data: digestRow, error: digestError } = await supabase
    .from("digests")
    .select("id, date, last_generated_at")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();

  if (digestError) throw new Error(`getDigestForDate: ${digestError.message}`);
  if (!digestRow) return null;

  const [{ data: cardRows, error: cardsError }, bookmarkedIds] = await Promise.all([
    supabase
      .from("cards")
      .select("id, topic, short_summary, expanded_report, sources, published_at")
      .eq("digest_id", digestRow.id)
      .order("published_at", { ascending: false }),
    getBookmarkedCardIds(supabase, userId),
  ]);

  if (cardsError) {
    throw new Error(`getDigestForDate: failed to load cards: ${cardsError.message}`);
  }

  return {
    id: digestRow.id,
    date: digestRow.date,
    lastGeneratedAt: digestRow.last_generated_at,
    cards: (cardRows ?? []).map((row) => rowToCard(row as CardRow, bookmarkedIds)),
  };
}

export async function getTodayDigest(
  supabase: SupabaseClient,
  userId: string
): Promise<Digest | null> {
  return getDigestForDate(supabase, userId, todayDateString());
}

export interface DigestDateSummary {
  date: string;
  cardCount: number;
}

/**
 * Past dates this user has a digest for, most recent first — the data
 * behind the Phase 3 history list. `range` is the extension point for a
 * future real calendar-grid view: a month view would call this with that
 * month's bounds instead of leaving it unbounded.
 */
export async function listDigestDatesForUser(
  supabase: SupabaseClient,
  userId: string,
  range?: { from: string; to: string }
): Promise<DigestDateSummary[]> {
  let query = supabase
    .from("digests")
    .select("date, cards(count)")
    .eq("user_id", userId)
    .order("date", { ascending: false });

  if (range) {
    query = query.gte("date", range.from).lte("date", range.to);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listDigestDatesForUser: ${error.message}`);

  return (data ?? []).map((row) => {
    const cards = row.cards as { count: number }[] | { count: number } | null;
    const cardCount = Array.isArray(cards) ? (cards[0]?.count ?? 0) : (cards?.count ?? 0);
    return { date: row.date as string, cardCount };
  });
}

/**
 * Finds or creates today's digest row for this user, returning its id and
 * the cursor (`lastGeneratedAt`) the pipeline should filter articles
 * "since." Null means no successful generation run has completed for this
 * digest yet — the pipeline's ingest step already treats null the same way
 * as a first-ever digest (falls back to its own lookback window), which is
 * exactly right for a freshly created row too.
 */
export async function upsertDigestForToday(
  supabase: SupabaseClient,
  userId: string
): Promise<{ digestId: string; lastGeneratedAt: string | null }> {
  const date = todayDateString();

  const { data: existing, error: selectError } = await supabase
    .from("digests")
    .select("id, last_generated_at")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();

  if (selectError) throw new Error(`upsertDigestForToday: ${selectError.message}`);
  if (existing) {
    return { digestId: existing.id, lastGeneratedAt: existing.last_generated_at };
  }

  const id = crypto.randomUUID();
  const { error: insertError } = await supabase
    .from("digests")
    .insert({ id, user_id: userId, date });

  if (insertError) {
    // A concurrent request (e.g. a double-click) already created today's
    // row between the select above and this insert — the unique
    // (user_id, date) constraint caught it. Re-select instead of failing
    // the whole digest request over a race that already resolved itself.
    if (insertError.code === UNIQUE_VIOLATION) {
      return upsertDigestForToday(supabase, userId);
    }
    throw new Error(`upsertDigestForToday: failed to create digest: ${insertError.message}`);
  }

  return { digestId: id, lastGeneratedAt: null };
}

/**
 * Persists a batch of freshly generated cards under an existing digest, and
 * advances that digest's since-cursor to now — called once per successful
 * generation run, after writeCard has produced the final card list. Both
 * writes happen inside one Postgres function (persist_generated_cards, see
 * schema.sql) so they're atomic: two separate supabase-js calls here would
 * leave a real gap where a crash between them persists cards but never
 * advances the cursor, causing the next run to re-ingest the same window
 * and insert a near-duplicate batch.
 */
export async function saveGeneratedCards(
  supabase: SupabaseClient,
  digestId: string,
  cards: Card[]
): Promise<void> {
  const { error } = await supabase.rpc("persist_generated_cards", {
    p_digest_id: digestId,
    p_cards: cards.map((card) => ({
      id: card.id,
      topic: card.topic,
      shortSummary: card.shortSummary,
      sources: card.sources,
      publishedAt: card.publishedAt,
    })),
    p_generated_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`saveGeneratedCards: ${error.message}`);
  }
}

// How long a "generating" claim is honored before it's considered stale and
// reclaimable — comfortably longer than the digest route's own
// maxDuration (60s), so a genuinely in-flight generation is never falsely
// reclaimed, but a claim left behind by a hard function-timeout kill (which
// can skip a JS `finally` block entirely) self-heals instead of wedging a
// digest permanently.
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Atomically claims this digest for generation, so two concurrent requests
 * (double-click, two open tabs) can't both run the pipeline and both
 * persist a batch of cards for the same window. Returns false if another
 * request already holds a live (non-stale) claim — the caller should
 * refuse to start the pipeline in that case, not run it anyway.
 *
 * The compare-and-swap is a single UPDATE ... WHERE — Postgres only lets
 * one concurrent transaction's WHERE clause match the not-yet-updated row,
 * so this is safe without an explicit lock.
 */
export async function claimDigestForGeneration(
  supabase: SupabaseClient,
  digestId: string
): Promise<boolean> {
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

  const { data, error } = await supabase
    .from("digests")
    .update({ generating: true, generation_started_at: new Date().toISOString() })
    .eq("id", digestId)
    .or(`generating.eq.false,generation_started_at.lt.${staleCutoff}`)
    .select("id");

  if (error) throw new Error(`claimDigestForGeneration: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Releases a generation claim — always called once the pipeline is done, whether it succeeded, threw, or was canceled (see the try/finally around runDigestPipeline's body). */
export async function releaseDigestGeneration(
  supabase: SupabaseClient,
  digestId: string
): Promise<void> {
  const { error } = await supabase
    .from("digests")
    .update({ generating: false })
    .eq("id", digestId);

  if (error) {
    // Not re-thrown: failing to clear the flag shouldn't mask whatever the
    // pipeline itself produced. Worst case this digest's claim sits until
    // the staleness window above lets a future request reclaim it.
    console.error(`releaseDigestGeneration: ${error.message}`);
  }
}
