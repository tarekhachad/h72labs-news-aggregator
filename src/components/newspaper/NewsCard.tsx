"use client";

import { useState } from "react";
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

/**
 * One story box on the front page or a topic page. Static/non-animated for
 * now (B5) — the Sources toggle below is plain show/hide; B6 upgrades it to
 * a CSS 3D flip, and B7 adds a click-to-focus overlay for the full report
 * (not built here at all yet, per the 4.4 plan's animation-last ordering).
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
  const [sourcesVisible, setSourcesVisible] = useState(false);
  const [bookmarked, setBookmarked] = useState(card.bookmarked);
  const [bookmarkPending, setBookmarkPending] = useState(false);

  async function handleBookmarkToggle() {
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

  return (
    <div
      className={cn(TIER_SPAN[tier], "relative flex flex-col rounded-md p-5")}
      style={{
        background: "var(--color-card)",
        color: "var(--color-card-foreground)",
        border: "1px solid var(--color-border)",
      }}
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
          onClick={handleBookmarkToggle}
          disabled={bookmarkPending}
          className="cursor-pointer text-xs font-medium underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          {bookmarked ? "★ Saved" : "☆ Save"}
        </button>
        <button
          onClick={() => setSourcesVisible((v) => !v)}
          className="cursor-pointer text-xs font-medium underline"
        >
          {sourcesVisible ? "Hide sources" : `Sources (${card.sources.length})`}
        </button>
      </div>

      {sourcesVisible && (
        // Absolutely positioned, not inline: the card's height is fixed by
        // its grid tier (see PageGrid), so an inline-expanding list would
        // either get clipped or force the tier's sizing to lie about box
        // shape. Popping out over the card (and whatever's below it in the
        // dense-packed grid) is the B5 stopgap — B6 replaces this whole
        // interaction with a real flip, per the 4.4 plan's animation-last
        // ordering. max-h + overflow-y-auto is a safety net for a story
        // with many sources, since even a popover has to stop somewhere.
        <ul
          className="absolute top-full right-0 left-0 z-20 mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md p-3"
          style={{
            background: "var(--color-card)",
            border: "1px solid var(--color-border)",
            boxShadow: "0 4px 6px rgba(26,26,26,0.10)",
          }}
        >
          {card.sources.map((s, j) => (
            <li key={j} className="text-xs" style={{ color: "var(--color-muted-foreground)" }}>
              <span className="font-medium">{s.source}</span> —{" "}
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
