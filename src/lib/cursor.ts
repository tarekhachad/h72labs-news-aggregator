/**
 * One definition of "this since-cursor is too far ahead of the clock to be
 * a real timestamp," shared by the two places that have to agree on it:
 * getLatestGeneratedAtForUser (which refuses to *select* such a value) and
 * ingestArticles (which refuses to *use* one that reaches it anyway).
 *
 * Kept in its own module rather than duplicated, for the same reason
 * entranceTiming.ts exists: two copies of a threshold bound only by a
 * comment drift apart, and here drift would be silent — the query would
 * accept a value the consumer then discards, quietly reintroducing the
 * every-run 48h re-ingest this pair exists to prevent.
 */

/**
 * How far ahead of the reader's clock a stored `last_generated_at` may sit
 * before it's read as corrupt rather than as clock skew.
 *
 * Generous on purpose, because the two mistakes are not symmetric. Reading
 * real skew as corruption costs a re-ingested 48h window on every run (a
 * writer running a few seconds fast would trip it forever); tolerating a few
 * minutes of genuine skew costs one run that finds nothing, which is anyway
 * the truthful answer to "what's new since a moment ago."
 */
export const FUTURE_CURSOR_TOLERANCE_MS = 5 * 60 * 1000;

/** The newest timestamp still considered a plausible cursor, as an ISO string. */
export function plausibleCursorLimitIso(now: number = Date.now()): string {
  return new Date(now + FUTURE_CURSOR_TOLERANCE_MS).toISOString();
}

/** True when `when` is far enough ahead of `now` to be corruption, not skew. */
export function isImplausiblyFuture(when: Date, now: number = Date.now()): boolean {
  return when.getTime() > now + FUTURE_CURSOR_TOLERANCE_MS;
}
