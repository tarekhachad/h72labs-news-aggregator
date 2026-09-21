/**
 * What has to happen after a digest run, however it ended: settle the spend
 * reservation, then let go of the generation claim.
 *
 * This lives outside the route for the same reason `ndjsonStream` does — Next
 * forbids extra exports from a route module, so anything in there is
 * unreachable from a test. The abandoned-run amount in particular cannot be
 * checked through the route at all: reaching that path needs the stream
 * cancelled before its first pull, and constructing the stream already
 * triggers that pull before a caller can get the response back.
 */

import { type SupabaseClient } from "@supabase/supabase-js";
import { settleSpend, type Reservation } from "@/lib/spend";
import { releaseGenerationClaim, type GenerationClaim } from "@/lib/generationClaim";

/**
 * Money first, then the claim.
 *
 * The order matters and is not interchangeable: `settleSpend` is bounded by
 * its own timeout and never throws, so it cannot hold the release hostage,
 * whereas a release waiting behind an unbounded settle could strand the claim
 * for the whole staleness window and lock the user out.
 */
export async function settleThenRelease(
  supabase: SupabaseClient,
  reservation: Reservation,
  claim: GenerationClaim,
  amountUsd: number | null
): Promise<void> {
  await settleSpend(reservation, amountUsd);
  await releaseGenerationClaim(supabase, claim);
}

/**
 * Cleanup for a request abandoned before the pipeline body ever ran.
 *
 * Such a run made no Claude call, so it settles at exactly zero — the caller
 * gets the whole reservation back. Keeping the amount here rather than at the
 * call site is deliberate: this is the one cleanup path no route-level test
 * can reach, so the figure belongs somewhere a test can hold it to account.
 * A $0 settle also frees the run-count slot, so an abandoned request costs the
 * user neither money nor one of their four daily runs.
 */
export async function settleAbandonedRun(
  supabase: SupabaseClient,
  reservation: Reservation,
  claim: GenerationClaim
): Promise<void> {
  await settleThenRelease(supabase, reservation, claim, 0);
}
