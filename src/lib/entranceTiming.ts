/**
 * Timing for the entrance animation played by cards that arrive live from a
 * digest generation.
 *
 * Shared rather than hardcoded at each use site because two separate places
 * must agree on it: NewsCard, which actually runs the Motion animation, and
 * DigestGenerationContext, whose per-batch timer force-retires a card's
 * pending entrance once the animation must be over. If the timer were ever
 * shorter than the real animation it would retire a card mid-flight — which
 * is precisely the bug shape that broke Phase 8.4 twice (a card retired
 * while animating loses its `animate` target and freezes part-faded). A
 * comment asserting "these must match" was the previous arrangement and is
 * exactly what a shared constant exists to replace.
 */

/** How long a single card's fade/scale-in runs. */
export const ENTRANCE_DURATION_SECONDS = 0.3;

/**
 * Gap between consecutive cards in one batch, so a run's cards read as
 * arriving one after another rather than all at once.
 */
export const ENTRANCE_STAGGER_SECONDS = 0.04;
