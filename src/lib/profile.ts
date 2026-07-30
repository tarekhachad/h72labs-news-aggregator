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

/**
 * Loads a user's saved topic/source preferences — same shape the Phase 1
 * hardcoded devProfile had, so the pipeline functions don't change.
 * Defensively drops any DB row no longer in the current curated list
 * (TOPICS/SOURCES), in case that list is ever edited later.
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

  const topicSet = new Set<string>(TOPICS);
  const sourceSet = new Set<string>(SOURCES);

  const topics = (topicRows ?? [])
    .map((r) => r.topic as string)
    .filter((t): t is Topic => topicSet.has(t));

  const preferredSources = (sourceRows ?? [])
    .map((r) => r.source as string)
    .filter((s): s is Source => sourceSet.has(s));

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
