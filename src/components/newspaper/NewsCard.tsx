"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Card } from "@/types";
import { formatRelativeTime } from "@/lib/time";
import { TIER_SPAN, type GridTier } from "@/lib/gridTiers";
import { cn } from "@/lib/utils";

// Card.shortSummary is one 2-4 sentence paragraph (not a separate
// headline + body) — each tier renders it once, sized and clamped so the
// meta row above and the Save/Sources row below always have guaranteed
// room within the tier's fixed grid-cell height (verified live, not just
// estimated — see the B5 session log entry on the overflow bug this
// replaced).
const TEXT_CLASS: Record<GridTier, string> = {
  hero: "text-2xl leading-snug line-clamp-6",
  large: "text-lg leading-snug line-clamp-5",
  medium: "text-base leading-snug line-clamp-3",
  small: "text-sm leading-snug line-clamp-2",
};

const CARD_FACE_STYLE = {
  background: "var(--color-card)",
  color: "var(--color-card-foreground)",
  border: "1px solid var(--color-border)",
} as const;

/**
 * One story box on the front page or a topic page. Flips in place to
 * reveal sources (B6) — E-Ink/Paper's own motion note calls for "sharp
 * transitions (no fade)," which is exactly what a rotation gives over a
 * cross-fade. B7 adds a click-to-focus overlay for the full report (not
 * built here yet, per the 4.4 plan's animation-last ordering) — Save and
 * Sources both stop click propagation now so a future card-level focus
 * trigger doesn't fire when using either control.
 */
export function NewsCard({
  card,
  tier,
  showTopicBadge,
}: {
  card: Card;
  tier: GridTier;
  /** Front page spans multiple topics (badge needed); a topic page's cards are all the same topic (badge is redundant there). */
  showTopicBadge: boolean;
}) {
  const [flipped, setFlipped] = useState(false);
  const [bookmarked, setBookmarked] = useState(card.bookmarked);
  const [bookmarkPending, setBookmarkPending] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const sourcesButtonRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const prevFlipped = useRef(flipped);

  // Per the inert spec, marking a subtree inert while it contains the
  // focused element forcibly ejects focus to <body> — a keyboard user who
  // activates "Sources" would otherwise be dropped to the top of the page
  // instead of landing on the newly-revealed back face. Move focus to the
  // face that just became reachable, both directions, matching the
  // standard ARIA disclosure-pattern convention. Compares against the
  // previous value rather than a one-shot "is this the first run" flag —
  // React Strict Mode double-invokes effects on mount in dev (no cleanup
  // resets between the two calls here), which made an earlier one-shot-flag
  // version fire the "real" branch on its second, synthetic invocation,
  // stealing focus on every dev-mode page load. This comparison is
  // idempotent under a repeated invocation instead of relying on a flag
  // only ever true once.
  useEffect(() => {
    if (prevFlipped.current !== flipped) {
      if (flipped) {
        backButtonRef.current?.focus();
      } else {
        sourcesButtonRef.current?.focus();
      }
    }
    prevFlipped.current = flipped;
  }, [flipped]);

  async function handleBookmarkToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (bookmarkPending) return;
    const next = !bookmarked;
    setBookmarkPending(true);
    setBookmarked(next); // Optimistic — reverted below on failure.
    try {
      const res = await fetch("/api/bookmarks", {
        method: next ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setBookmarked(!next);
    } finally {
      setBookmarkPending(false);
    }
  }

  function handleFlip(e: React.MouseEvent) {
    e.stopPropagation();
    setFlipped((v) => !v);
  }

  return (
    <div className={cn(TIER_SPAN[tier], "relative")} style={{ perspective: "1200px" }}>
      <motion.div
        className="relative h-full w-full"
        style={{ transformStyle: "preserve-3d" }}
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.5, ease: "easeInOut" }}
      >
        {/* Front face. inert when the back face is showing — backface-visibility
            only hides it visually, it doesn't remove it from tab order or the
            accessibility tree, so without this a keyboard/screen-reader user
            could reach and activate controls that are invisibly rotated away. */}
        <div
          className="absolute inset-0 flex flex-col overflow-hidden rounded-md p-5"
          style={{ ...CARD_FACE_STYLE, backfaceVisibility: "hidden" }}
          inert={flipped}
        >
          <div className="flex items-center justify-between gap-2">
            {showTopicBadge ? (
              <span
                className="w-fit rounded px-2 py-0.5 text-xs font-semibold"
                style={{ background: "var(--color-muted)", color: "var(--color-muted-foreground)" }}
              >
                {card.topic}
              </span>
            ) : (
              <span />
            )}
            <span className="text-xs" style={{ color: "var(--color-muted-foreground)" }}>
              {formatRelativeTime(card.publishedAt)}
            </span>
          </div>

          <p className={cn(TEXT_CLASS[tier], "mt-2 font-semibold")}>{card.shortSummary}</p>

          <div className="mt-auto flex items-center gap-4 pt-3">
            <button
              type="button"
              onClick={handleBookmarkToggle}
              disabled={bookmarkPending}
              className="cursor-pointer text-xs font-medium underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bookmarked ? "★ Saved" : "☆ Save"}
            </button>
            <button
              ref={sourcesButtonRef}
              type="button"
              onClick={handleFlip}
              aria-expanded={flipped}
              className="cursor-pointer text-xs font-medium underline"
            >
              {`Sources (${card.sources.length})`}
            </button>
          </div>
        </div>

        {/* Back face — pre-rotated 180deg so it reads right-way-round once the
            card has flipped. inert while the front face is showing, same
            reasoning as the front face's inert above. */}
        <div
          className="absolute inset-0 flex flex-col overflow-hidden rounded-md p-5"
          style={{
            ...CARD_FACE_STYLE,
            backfaceVisibility: "hidden",
            transform: "rotateY(180deg)",
          }}
          inert={!flipped}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold" style={{ color: "var(--color-muted-foreground)" }}>
              SOURCES
            </span>
            <button
              ref={backButtonRef}
              type="button"
              onClick={handleFlip}
              className="cursor-pointer text-xs font-medium underline"
            >
              Back
            </button>
          </div>

          <ul className="mt-2 flex flex-col gap-2 overflow-y-auto">
            {card.sources.map((s) => (
              <li key={s.url} className="text-xs" style={{ color: "var(--color-muted-foreground)" }}>
                <span className="font-medium">{s.source}</span> —{" "}
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="underline"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
    </div>
  );
}
