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
  created_at: string;
  severity: number | null;
  front_page_rank: number | null;
  title: string | null;
  labels: string[] | null;
}

/** Shared DB-row -> Card mapper — also used by bookmarks.ts's getSavedCards
 * so the two don't hand-roll the same field mapping independently. */
export function rowToCard(row: CardRow, bookmarkedIds: Set<string>): Card {
  return {
    id: row.id,
    topic: row.topic as Topic,
    // Same defensive-fallback pattern as severity below — a pre-5.5 row
    // has no title/labels, and Card's fields aren't nullable, so a legacy
    // row renders with an empty title/no chips rather than a type error.
    title: row.title ?? "",
    shortSummary: row.short_summary,
    labels: row.labels ?? [],
    expandedReport: row.expanded_report,
    sources: row.sources,
    publishedAt: row.published_at,
    generatedAt: row.created_at,
    bookmarked: bookmarkedIds.has(row.id),
    // Rows persisted before this column existed have no severity — default
    // to the lowest tier rather than letting a null flow into gridTiers.ts.
    severity: row.severity ?? 1,
    frontPageRank: row.front_page_rank,
  };
}

// The digest "date" is a UTC calendar day, not the visiting user's local
// day — a deliberate v1 simplification (this app has no per-user timezone
// setting yet). Confirmed a real, recurring complaint (not just a
// theoretical edge case) 2026-08-07: a user well west of UTC sees "today"
// roll over several hours before their own local midnight, silently
// reclassifying that day's digest as history. Deferred, not fixed —
// see docs/(C) ROADMAP.md's "Explicitly deferred" section for what a real
// fix needs.
//
// Exported as of Phase 8.1 so the history route guards can ask "is this
// date today?" without minting yet another copy. Every server-side caller
// now imports it from here. It remains duplicated by hand in FrontPage.tsx
// and DigestGenerationContext.tsx, which are client components and so
// genuinely cannot import this server module — those two are the other
// call sites a real timezone fix has to reach.
export function todayDateString(): string {
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
      .select(
        "id, topic, short_summary, expanded_report, sources, published_at, created_at, severity, front_page_rank, title, labels"
      )
      .eq("digest_id", digestRow.id)
      // Secondary key on id: published_at ties are common (minute-granularity
      // RSS timestamps, or writeCard's now()-fallback for undated items), and
      // without a tiebreaker Postgres doesn't guarantee stable order for tied
      // rows across separate query executions — cards would visibly swap
      // places between reloads even though nothing about them changed.
      .order("published_at", { ascending: false })
      .order("id", { ascending: true }),
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

/**
 * Cheap existence check for "does this date have a real, renderable digest"
 * — factored out for callers (Phase 6.4's topic-nav gating) that only need
 * the boolean, not the full cards payload + bookmark join
 * getDigestForDate/getTodayDigest do. Deliberately checks for at least one
 * *card*, not just a `digests` row: upsertDigestForToday creates that row
 * immediately when generation starts, well before any pipeline stage runs
 * or any card is persisted (see src/app/api/digest/route.ts's POST
 * handler) — a bare row-existence check was true for the entire generation
 * window, which is exactly what Phase 7.2 found wrongly un-gating the
 * topic nav while a digest was still mid-generation.
 */
export async function digestExistsForDate(
  supabase: SupabaseClient,
  userId: string,
  date: string
): Promise<boolean> {
  const { data: digestRow, error } = await supabase
    .from("digests")
    .select("id")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();

  if (error) throw new Error(`digestExistsForDate: ${error.message}`);
  if (!digestRow) return false;

  const { data: anyCard, error: cardsError } = await supabase
    .from("cards")
    .select("id")
    .eq("digest_id", digestRow.id)
    .limit(1);

  if (cardsError) throw new Error(`digestExistsForDate: ${cardsError.message}`);
  return (anyCard?.length ?? 0) > 0;
}

/**
 * Cards for one topic on one date — the query behind each topic-page route.
 * Deliberately scoped server-side to just this topic (a join through
 * `digests` on user_id+date, filtered by topic), not a fetch-everything-
 * then-filter-in-memory reuse of getDigestForDate: each topic page is now
 * its own route (see docs/(C) IMPLEMENTATION_PLAN_4.4.md's B5), so there's
 * no longer a single client holding the whole day's digest to filter from.
 * Returns an empty array (not null) for a topic with no cards today or no
 * digest at all yet — both render the same "no notable news" empty state,
 * so the caller doesn't need to distinguish them.
 */
export async function getCardsForTopicOnDate(
  supabase: SupabaseClient,
  userId: string,
  date: string,
  topic: Topic
): Promise<Card[]> {
  const { data: digestRow, error: digestError } = await supabase
    .from("digests")
    .select("id")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();

  if (digestError) throw new Error(`getCardsForTopicOnDate: ${digestError.message}`);
  if (!digestRow) return [];

  const [{ data: cardRows, error: cardsError }, bookmarkedIds] = await Promise.all([
    supabase
      .from("cards")
      .select(
        "id, topic, short_summary, expanded_report, sources, published_at, created_at, severity, front_page_rank, title, labels"
      )
      .eq("digest_id", digestRow.id)
      .eq("topic", topic)
      .order("published_at", { ascending: false })
      .order("id", { ascending: true }),
    getBookmarkedCardIds(supabase, userId),
  ]);

  if (cardsError) {
    throw new Error(`getCardsForTopicOnDate: failed to load cards: ${cardsError.message}`);
  }

  return (cardRows ?? []).map((row) => rowToCard(row as CardRow, bookmarkedIds));
}

/**
 * Today's already-persisted card summaries for this digest — used by two
 * independent consumers: the cross-run duplicate check (src/lib/dedup.ts,
 * which only reads topic/shortSummary) and the cross-topic front-page
 * ranking pass (src/lib/rank.ts, which additionally needs id + severity to
 * fold earlier runs' cards into today's re-ranked candidate pool and know
 * which row to update). One shared query rather than two near-duplicate
 * ones — dedup.ts's structural typing just ignores the extra fields.
 */
export async function getTodaysCardSummaries(
  supabase: SupabaseClient,
  digestId: string
): Promise<{ id: string; topic: Topic; shortSummary: string; severity: number }[]> {
  const { data, error } = await supabase
    .from("cards")
    .select("id, topic, short_summary, severity")
    .eq("digest_id", digestId);

  if (error) throw new Error(`getTodaysCardSummaries: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    topic: row.topic as Topic,
    shortSummary: row.short_summary as string,
    severity: (row.severity as number | null) ?? 1,
  }));
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
 *
 * Strictly *past* dates: today is excluded (Phase 8.1). The front page is
 * today's home, so listing it here too was pure duplication — and worse
 * than cosmetic, because upsertDigestForToday creates the `digests` row
 * the moment generation *starts*, so today appeared in history while it
 * was still mid-generation and had nothing to show. It reappears here
 * tomorrow, when it genuinely is history.
 *
 * Dates with zero cards are dropped for the same reason, and this is
 * where the two "does a digest exist" checks in this file are brought
 * back into agreement: Phase 7.2 changed digestExistsForDate to require
 * at least one `cards` row rather than trusting the bare `digests` row,
 * for exactly this reason, but left this function checking row existence
 * only — so a day whose generation started and produced nothing (every
 * cluster failing triage, or an abandoned run) still rendered as a
 * clickable "0 cards" entry leading to an empty page.
 *
 * Note the exclusion is against the UTC day, like every other date
 * boundary in this app — see todayDateString()'s comment above for the
 * known, deferred consequence of that for users well west of UTC.
 *
 * The zero-card filter runs in JS after the query rather than in SQL
 * because PostgREST can't filter parent rows on an embedded aggregate's
 * value without a view or RPC — not worth either for a list this small.
 * That's fine for the date-range windowing `range` is meant for, but it
 * would break true row-based pagination: a LIMIT/OFFSET page would be
 * counted before this filter and could come back short. Move the filter
 * into a view or RPC first if that's ever built.
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
    .lt("date", todayDateString())
    .order("date", { ascending: false });

  if (range) {
    query = query.gte("date", range.from).lte("date", range.to);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listDigestDatesForUser: ${error.message}`);

  return (data ?? [])
    .map((row) => {
      const cards = row.cards as { count: number }[] | { count: number } | null;
      const cardCount = Array.isArray(cards) ? (cards[0]?.count ?? 0) : (cards?.count ?? 0);
      return { date: row.date as string, cardCount };
    })
    .filter((summary) => summary.cardCount > 0);
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
 * generation run, applies rank.ts's cross-topic ranking pass to cards
 * already persisted in an earlier run today (this run's own new cards get
 * their frontPageRank set directly via the `cards` param instead), and
 * advances the digest's since-cursor. All three happen inside one Postgres
 * function (persist_generated_cards, see schema.sql) so they're atomic —
 * originally the existing-card rank update was a separate best-effort RPC
 * called after this one, but code review caught a real gap in that split:
 * if this call succeeded and the second one then failed, a newly-inserted
 * card and a stale existing card could simultaneously claim the same
 * front_page_rank until the next successful run overwrote both. Folding
 * both writes into one transaction here closes that window rather than
 * just documenting it as accepted risk. (The insert+cursor-advance
 * atomicity has the same underlying reasoning: two separate supabase-js
 * calls would leave a real gap where a crash between them persists cards
 * but never advances the cursor, causing the next run to re-ingest the
 * same window and insert a near-duplicate batch.)
 *
 * generatedAt is passed in (not computed here) so the caller can stamp the
 * exact same value onto the in-memory Card objects it returns to the client
 * — that's what lets the feed badge the newest run's cards immediately
 * after a second same-day generation, without needing a reload to see it.
 *
 * existingRankUpdates is rank.ts's fail-open contract made concrete: an
 * empty array (ranking failed, or there was nothing new to rank this run)
 * is a correct no-op in the underlying SQL, not a special case here.
 */
export async function saveGeneratedCards(
  supabase: SupabaseClient,
  digestId: string,
  cards: Card[],
  generatedAt: string,
  existingRankUpdates: { id: string; frontPageRank: number | null }[]
): Promise<void> {
  const { error } = await supabase.rpc("persist_generated_cards", {
    p_digest_id: digestId,
    p_cards: cards.map((card) => ({
      id: card.id,
      topic: card.topic,
      title: card.title,
      shortSummary: card.shortSummary,
      labels: card.labels,
      sources: card.sources,
      publishedAt: card.publishedAt,
      severity: card.severity,
      frontPageRank: card.frontPageRank,
    })),
    p_generated_at: generatedAt,
    p_existing_rank_updates: existingRankUpdates,
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
