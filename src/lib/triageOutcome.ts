// Kept apart from triage.ts, which holds an Anthropic client, so the route can
// tell a fail-closed cluster from a rejected one without importing that client.

export interface TriageOutcome {
  notable: boolean;
  severity: number;
}

/**
 * The verdict every unjudged cluster falls back to. Fail-closed: an
 * unjudged cluster is dropped from the brief rather than written up
 * unreviewed, matching the per-cluster convention this module has always
 * had (F.3 measured triage at 65% of spend precisely because it gates the
 * expensive Sonnet step — letting an unjudged cluster through would spend
 * Sonnet money on something nothing has vetted).
 */
// Frozen because one shared reference is handed to every unjudged cluster
// in a response. Nothing mutates a TriageOutcome today (the route reads the
// two fields into fresh objects), but if anything ever did, a single
// in-place write would silently rewrite the verdict of every other
// fail-closed cluster in the same digest. Same hazard usage.ts's frozen
// ZERO_TOKENS singleton exists to prevent.
export const FAIL_CLOSED: TriageOutcome = Object.freeze({
  notable: false,
  severity: 1,
});

/**
 * True when `triageClusters` could not get a verdict for this cluster and
 * failed it closed, as opposed to the model judging it not notable. The two
 * carry identical fields, so identity with the shared singleton is the only
 * thing that tells them apart; a copied outcome loses it.
 */
export function isFailClosed(outcome: TriageOutcome): boolean {
  return outcome === FAIL_CLOSED;
}
