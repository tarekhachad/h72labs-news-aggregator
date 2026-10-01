/**
 * Timing for the entrance animation played by cards that arrive live from a
 * digest generation.
 *
 * Shared rather than hardcoded at each use site because two separate places
 * must agree on it: NewsCard, which actually runs the Motion animation, and
 * DigestGenerationContext, whose per-batch timer force-retires a card's
 * pending entrance once the animation should be over. The timer is set longer
 * than the animation so that, in a visible tab, a card is retired after its
 * entrance has finished rather than during it.
 *
 * The two only agree while the tab is visible. The animation runs on
 * requestAnimationFrame, which a hidden tab never fires; the timer is
 * wall-clock and still does. So a card can be retired before its entrance has
 * played a single frame, and NewsCard is built for that: the entrance is a
 * scale-in over a card that is already fully visible, and retiring it leaves
 * the animation to finish at natural size once frames run again. A late or
 * early retire costs, at worst, the animation — never the card's visibility.
 */

/** How long a single card's scale-in runs. */
export const ENTRANCE_DURATION_SECONDS = 0.3;

/**
 * Gap between consecutive cards in one batch, so a run's cards read as
 * arriving one after another rather than all at once.
 */
export const ENTRANCE_STAGGER_SECONDS = 0.04;
