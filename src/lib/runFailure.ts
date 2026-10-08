import type { CardFailure } from "@/lib/cardFailure";

/**
 * A digest run that produced nothing because a whole stage failed (every
 * triage call, or every card), as opposed to a quiet news day. Saving such a
 * run would move the since-cursor past every article it read and show the
 * reader an empty brief, so the route throws this instead and nothing is
 * saved: the cursor stays put and the next run reads the same window again.
 */

/** Shown to the reader. Fixed text: nothing from the underlying failure reaches the browser. */
export const RUN_FAILED_MESSAGE =
  "We couldn't write your digest just now. Nothing was lost; please try again later.";

/**
 * Thrown from the digest pipeline when a run must end without saving. The
 * stream sends the reader `RUN_FAILED_MESSAGE` for it, where any other throw
 * gets the generic message; `message` carries the detail for the server log.
 */
export class WholeRunFailure extends Error {
  readonly readerMessage = RUN_FAILED_MESSAGE;

  constructor(detail: string) {
    super(detail);
    this.name = "WholeRunFailure";
  }
}

/** Every cluster sent to triage came back unjudged. Zero clusters is a quiet run, not a failure. */
export function everyTriageFailed(clustersTriaged: number, failedClosed: number): boolean {
  return clustersTriaged > 0 && failedClosed === clustersTriaged;
}

/**
 * Stories were picked for cards, not one was written, and every failure was
 * an API error: nothing billed, and a retry may well succeed. A card Claude
 * answered and the app refused tends to fail the same way again, so a run
 * lost to those is saved as before rather than sending the reader into a
 * paid retry that re-reads the same stories and fails again.
 */
export function everyCardFailed(cardsAttempted: number, failures: readonly CardFailure[]): boolean {
  return cardsAttempted > 0 && failures.length === cardsAttempted && failures.every((f) => f.reason === "apiError");
}
