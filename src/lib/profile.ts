import type { SupabaseClient } from "@supabase/supabase-js";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";

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
