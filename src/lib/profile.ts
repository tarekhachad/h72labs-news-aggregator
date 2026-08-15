import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";

// Shared by onboarding and the profile/edit page's Server Actions — kept out
// of those "use server" files since such files may only export async
// functions, not plain values like a zod schema.
//
// Deduping after the min-length check matters: user_topics/user_preferred_sources
// have a composite (user_id, topic) primary key, so a duplicate value reaching
// saveUserProfile's insert would violate it — and since delete-then-insert
// already committed the delete by that point, the failed insert would leave
// the user with zero saved preferences instead of their prior selection.
export const ProfileInput = z.object({
  topics: z
    .array(z.enum(TOPICS))
    .min(1, "Pick at least one topic")
    .transform((topics) => Array.from(new Set(topics))),
  preferredSources: z
    .array(z.enum(SOURCES))
    .min(1, "Pick at least one source")
    .transform((sources) => Array.from(new Set(sources))),
});

// Neither query below has an ORDER BY, and Postgres guarantees no row order
// without one — the same query can return the same rows in a different order
// between executions (plan choice, heap layout, page reuse after vacuum,
// concurrent writes). Every page is a server component that re-runs this on
// each render, so an unordered read showed up as the topic nav visibly
// reshuffling between navigations. saveUserProfile is delete-then-insert
// (the RLS design has no UPDATE policy), so every preference save rewrites
// all rows into fresh heap positions, which is what made it shift in
// practice rather than only in theory. Same defect class digests.ts already
// fixed with its published_at/id tiebreaker; this module never got it.
//
// Not `.order("topic")`: the intended order is the curated TOPICS grouping
// the user sees in PreferencesForm (tech → politics → regional → finance →
// sports), which is not alphabetical, so a plain .order() can't produce it.
// SQL could (array_position over a literal list), but that would put the
// curated order in two places that must be kept in step — TOPICS is meant to
// be the single runtime source of truth for it.
//
// Walking the curated list and keeping what's selected makes the result a
// subsequence of TOPICS by construction, so ordering, filtering out stale
// values, and deduping are one operation rather than three that could
// disagree. It also normalizes on the READ side, which makes
// saveUserProfile's write order irrelevant — nothing downstream should ever
// depend on checkbox DOM order again.
function inCuratedOrder<T extends string>(curated: readonly T[], rows: string[]): T[] {
  const selected = new Set(rows);
  return curated.filter((value) => selected.has(value));
}

/**
 * Loads a user's saved topic/source preferences — same shape the Phase 1
 * hardcoded devProfile had, so the pipeline functions don't change.
 * Both arrays come back in curated (TOPICS/SOURCES) order regardless of the
 * order the DB hands the rows back, and any stored value no longer in the
 * curated list is dropped by that same step.
 */
export async function getUserProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<{ topics: Topic[]; preferredSources: Source[] }> {
  const [
    { data: topicRows, error: topicError },
    { data: sourceRows, error: sourceError },
  ] = await Promise.all([
    supabase.from("user_topics").select("topic").eq("user_id", userId),
    supabase.from("user_preferred_sources").select("source").eq("user_id", userId),
  ]);

  // A transient DB/network error must not look like "user has zero
  // preferences" — that would bounce an already-onboarded user back to
  // /onboarding on a temporary failure instead of surfacing the real error.
  if (topicError) throw new Error(`getUserProfile: failed to load topics: ${topicError.message}`);
  if (sourceError) throw new Error(`getUserProfile: failed to load sources: ${sourceError.message}`);

  // Applied to preferredSources too. Its order is genuinely irrelevant to
  // today's consumers (a Set in ingest.ts, .includes() in PreferencesForm) —
  // but that's a property of today's callers, not of this function. One rule
  // for both arrays is a contract that fits in the head, and the next
  // consumer that maps over sources inherits the fix instead of
  // rediscovering the bug.
  const topics = inCuratedOrder(
    TOPICS,
    (topicRows ?? []).map((r) => r.topic as string)
  );

  const preferredSources = inCuratedOrder(
    SOURCES,
    (sourceRows ?? []).map((r) => r.source as string)
  );

  return { topics, preferredSources };
}

/**
 * Replaces a user's whole preference set (delete-then-insert), not in-place
 * edits — matches the RLS design (no UPDATE policy) and lets onboarding and
 * the profile/edit page share the same write path. Every step's error is
 * checked — if delete succeeds but insert fails, silently proceeding would
 * leave the user with zero saved preferences and no explanation.
 */
export async function saveUserProfile(
  supabase: SupabaseClient,
  userId: string,
  topics: Topic[],
  preferredSources: Source[]
): Promise<{ error: string | null }> {
  const [deleteTopics, deleteSources] = await Promise.all([
    supabase.from("user_topics").delete().eq("user_id", userId),
    supabase.from("user_preferred_sources").delete().eq("user_id", userId),
  ]);
  if (deleteTopics.error || deleteSources.error) {
    return { error: "Couldn't save your preferences — try again." };
  }

  const [insertTopics, insertSources] = await Promise.all([
    supabase.from("user_topics").insert(topics.map((topic) => ({ user_id: userId, topic }))),
    supabase
      .from("user_preferred_sources")
      .insert(preferredSources.map((source) => ({ user_id: userId, source }))),
  ]);
  if (insertTopics.error || insertSources.error) {
    return { error: "Couldn't save your preferences — try again." };
  }

  return { error: null };
}
