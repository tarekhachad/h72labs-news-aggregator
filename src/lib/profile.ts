import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";
import { DEFAULT_TIME_ZONE } from "@/lib/localDate";
import { MAX_READING_UNITS, MIN_READING_UNITS, countReadingUnits } from "@/lib/readingUnits";

// Shared by onboarding and the profile/edit page's Server Actions — kept out
// of those "use server" files since such files may only export async
// functions, not plain values like a zod schema.
//
// Deduping before the insert matters: user_topics/user_preferred_sources
// have a composite (user_id, topic) primary key, so a duplicate value reaching
// saveUserProfile's insert would violate it — and since delete-then-insert
// already committed the delete by that point, the failed insert would leave
// the user with zero saved preferences instead of their prior selection.
//
// The limits count distinct reading units (src/lib/readingUnits.ts): each
// topic is one, except Countries, which counts as nothing itself and one per
// picked country. So a duplicate can neither make up the third unit nor push
// a tenth over. Sources have no minimum: zero preferred sources means every
// source for the reader's topics.
//
// Named for topics because the preference form, which imports them, still
// talks about topics; they are the reading-unit limits.
export const MIN_TOPICS = MIN_READING_UNITS;
export const MAX_TOPICS = MAX_READING_UNITS;

const dedupe = <T>(values: T[]): T[] => Array.from(new Set(values));

export const ProfileInput = z
  .object({
    topics: z.array(z.enum(TOPICS)).transform(dedupe),
    preferredSources: z.array(z.enum(SOURCES)).transform(dedupe),
    // Optional so a form without the countries picker still parses. Plain
    // strings here, checked against COUNTRIES below only when Countries is
    // picked: a country left in the form after Countries was unticked is
    // dropped, not refused.
    countries: z.array(z.string()).default([]).transform(dedupe),
  })
  .transform((input, ctx) => {
    const withCountries = input.topics.includes(COUNTRIES_TOPIC);
    const countries = withCountries ? input.countries : [];

    const unknown = countries.find((country) => !COUNTRIES.includes(country));
    if (unknown !== undefined) {
      ctx.addIssue({ code: "custom", message: `${unknown} isn't a country you can pick` });
      return z.NEVER;
    }
    if (withCountries && countries.length === 0) {
      ctx.addIssue({ code: "custom", message: "Pick at least one country, or remove Countries" });
      return z.NEVER;
    }

    // Without Countries the messages stay exactly as they were; with it, they
    // say a country counts, since that is what makes 2 ticked topics plus a
    // country enough, and 8 topics plus 3 countries too many.
    const units = countReadingUnits(input.topics, countries);
    const counted = withCountries ? " topics and countries (each country counts as one)" : " topics";
    if (units < MIN_TOPICS) {
      ctx.addIssue({ code: "custom", message: `Pick at least ${MIN_TOPICS}${counted}` });
      return z.NEVER;
    }
    if (units > MAX_TOPICS) {
      ctx.addIssue({ code: "custom", message: `Pick at most ${MAX_TOPICS}${counted}` });
      return z.NEVER;
    }

    return { topics: input.topics, preferredSources: input.preferredSources, countries };
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
 * Loads a user's saved topic/source/country preferences — same shape the
 * Phase 1 hardcoded devProfile had, so the pipeline functions don't change.
 * All three arrays come back in curated (TOPICS/SOURCES/COUNTRIES) order
 * regardless of the order the DB hands the rows back, and any stored value no
 * longer in the curated list is dropped by that same step.
 */
export async function getUserProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<{ topics: Topic[]; preferredSources: Source[]; countries: string[]; timeZone: string }> {
  const [
    { data: topicRows, error: topicError },
    { data: sourceRows, error: sourceError },
    { data: countryRows, error: countryError },
    timeZone,
  ] = await Promise.all([
    supabase.from("user_topics").select("topic").eq("user_id", userId),
    supabase.from("user_preferred_sources").select("source").eq("user_id", userId),
    supabase
      .from("user_subtopics")
      .select("subtopic")
      .eq("user_id", userId)
      .eq("topic", COUNTRIES_TOPIC),
    getUserTimeZone(supabase, userId),
  ]);

  // A transient DB/network error must not look like "user has zero
  // preferences" — that would bounce an already-onboarded user back to
  // /onboarding on a temporary failure instead of surfacing the real error.
  if (topicError) throw new Error(`getUserProfile: failed to load topics: ${topicError.message}`);
  if (sourceError) throw new Error(`getUserProfile: failed to load sources: ${sourceError.message}`);
  // Same reasoning: read as empty, a reader with Countries would silently
  // stop getting country news and their picker would come up blank.
  if (countryError) throw new Error(`getUserProfile: failed to load countries: ${countryError.message}`);

  // Applied to preferredSources too. The preference pickers show saved picks
  // as chips in the order given here, and other consumers (a Set in
  // ingest.ts) don't care — but that's a property of today's callers, not
  // of this function. One rule
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

  // Only with the Countries topic: a save drops countries picked without it,
  // and the read keeps to the same rule rather than trusting the rows to.
  const countries = topics.includes(COUNTRIES_TOPIC)
    ? inCuratedOrder(
        COUNTRIES,
        (countryRows ?? []).map((r) => r.subtopic as string)
      )
    : [];

  return { topics, preferredSources, countries, timeZone };
}

/**
 * The timezone this user's "today" is computed in, or UTC when they have no
 * stored one yet.
 *
 * A failed read also degrades to UTC rather than throwing, unlike the topic
 * and source reads above. Those guard against bouncing an onboarded user to
 * /onboarding; the worst a wrong timezone does is file one run under the UTC
 * date, and TimeZoneSync rewrites the value on the next page load anyway.
 */
export async function getUserTimeZone(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("time_zone")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[profile] failed to load time zone, using UTC:", error.message);
    return DEFAULT_TIME_ZONE;
  }
  const stored = (data as { time_zone?: unknown } | null)?.time_zone;
  return typeof stored === "string" && stored.length > 0 ? stored : DEFAULT_TIME_ZONE;
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
  preferredSources: Source[],
  countries: string[]
): Promise<{ error: string | null }> {
  // Only the Countries rows are replaced: user_subtopics is shaped for other
  // topics' subtopics too, and this save knows nothing about those.
  const [deleteTopics, deleteSources, deleteCountries] = await Promise.all([
    supabase.from("user_topics").delete().eq("user_id", userId),
    supabase.from("user_preferred_sources").delete().eq("user_id", userId),
    supabase.from("user_subtopics").delete().eq("user_id", userId).eq("topic", COUNTRIES_TOPIC),
  ]);
  if (deleteTopics.error || deleteSources.error || deleteCountries.error) {
    return { error: "Couldn't save your preferences — try again." };
  }

  // Zero preferred sources (or countries) is a valid profile, and the delete
  // above already leaves it saved. The insert is skipped rather than sent
  // with an empty body, whose handling is PostgREST's to decide, not ours.
  const [insertTopics, insertSources, insertCountries] = await Promise.all([
    supabase.from("user_topics").insert(topics.map((topic) => ({ user_id: userId, topic }))),
    preferredSources.length === 0
      ? { error: null }
      : supabase
          .from("user_preferred_sources")
          .insert(preferredSources.map((source) => ({ user_id: userId, source }))),
    countries.length === 0
      ? { error: null }
      : supabase
          .from("user_subtopics")
          .insert(countries.map((subtopic) => ({ user_id: userId, topic: COUNTRIES_TOPIC, subtopic }))),
  ]);
  if (insertTopics.error || insertSources.error || insertCountries.error) {
    return { error: "Couldn't save your preferences — try again." };
  }

  return { error: null };
}
