/**
 * The generation mutex: at most one digest generation per user at a time.
 *
 * The enforcement is NOT here. It is `public.claim_generation` and
 * `public.release_generation` in supabase/schema.sql, which take and release
 * the claim in a table no session can touch, and clamp the staleness window
 * so a caller cannot ask to reclaim a run that is still going. This file only
 * calls them.
 *
 * The claim is keyed on the user. Neither function takes a digest id as part
 * of the exclusion, because a claim scoped to one day's digest row lets a UTC
 * midnight rollover start a second pipeline for the same user — two ingests,
 * duplicate cards, and two worst-case spend reservations.
 */

import { type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * How long this app asks for a claim to be honored before it may be
 * reclaimed. It must stay longer than the digest route's maxDuration, or a
 * live run's claim becomes reclaimable while that run is still going; a test
 * asserts that, and asserts it against the database's own floor too.
 *
 * The database clamps whatever is sent here, so this value can only ask to be
 * more conservative than the floor, never less.
 */
export const STALE_CLAIM_MS = 3 * 60 * 1000;

/** Proof that this run, and not a run that replaced it, holds the claim. */
export type GenerationClaim = { claimId: string };

const RELEASE_TIMEOUT_MS = 5_000;

const ClaimId = z.string().uuid();

/**
 * Takes the claim for the signed-in user, or returns null if that user
 * already holds a live one. The user comes from the session inside the
 * database function, never from an argument.
 *
 * Throws if the call itself fails. A refusal and a broken database are
 * different outcomes: without the distinction, an outage would be reported to
 * the user as "a digest is already being generated".
 *
 * Deliberately not bounded by a timeout, unlike the release below. A timeout
 * here would not cancel the statement, so a claim that commits late would be
 * held by a token nobody has — wedging the user until the staleness window
 * expires. A slow claim only makes the request slow, and the route's own
 * maxDuration already bounds that.
 */
export async function claimGenerationForUser(
  supabase: SupabaseClient,
  options: { staleMs?: number } = {}
): Promise<GenerationClaim | null> {
  const { data, error } = await supabase.rpc("claim_generation", {
    p_stale_ms: options.staleMs ?? STALE_CLAIM_MS,
  });

  if (error) throw new Error(`claimGenerationForUser: ${error.message}`);
  if (data === null) return null;

  const claimId = ClaimId.safeParse(data);
  if (!claimId.success) {
    throw new Error("claimGenerationForUser: claim_generation returned an unexpected shape");
  }
  return { claimId: claimId.data };
}

/**
 * Releases this run's claim. Never throws: it runs in the same `finally` that
 * settles the spend reservation, and a throw there would mask whatever the
 * pipeline produced.
 *
 * Bounded by a timeout because that `finally` is what closes the response
 * stream — a hang here would leave the stream open. The claim is already
 * on its way out either way, so unlike the claim above there is no state a
 * timeout can strand: the staleness window frees it.
 *
 * A false return is not an error but is worth a log line: it means this run's
 * claim had already been reclaimed as stale, so the token no longer matches
 * and some later run owns the claim now.
 */
export async function releaseGenerationClaim(
  supabase: SupabaseClient,
  claim: GenerationClaim
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { data, error } = await Promise.race([
      Promise.resolve(supabase.rpc("release_generation", { p_claim_id: claim.claimId })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${RELEASE_TIMEOUT_MS}ms`)),
          RELEASE_TIMEOUT_MS
        );
      }),
    ]);

    if (error) {
      console.error(`[claim] release_generation failed: ${error.message}`);
      return;
    }
    if (data !== true) {
      console.error("[claim] release_generation released nothing: this claim was already reclaimed");
    }
  } catch (err) {
    console.error(
      `[claim] release_generation threw: ${err instanceof Error ? err.message : "unknown error"}`
    );
  } finally {
    clearTimeout(timer);
  }
}
