"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import type { Card } from "@/types";
import { formatRelativeTime } from "@/lib/time";
import { TIER_SPAN, type GridTier } from "@/lib/gridTiers";
import { cn } from "@/lib/utils";
import { FocusOverlay } from "@/components/newspaper/FocusOverlay";
import { useFocusMode } from "@/components/newspaper/FocusModeContext";

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
 * cross-fade. Clicking the card body (front face only, not while flipped
 * to sources) opens focus mode (B7) — a zoom/blur overlay with the full
 * report, per docs/(C) UI_DESIGN.md. Save/Sources/source-links all stop
 * click propagation so they don't also open focus mode.
 */
export function NewsCard({
  card,
  tier,
  showTopicBadge,
  isNew = false,
  entranceDelay = 0,
}: {
  card: Card;
  tier: GridTier;
  /** Front page spans multiple topics (badge needed); a topic page's cards are all the same topic (badge is redundant there). */
  showTopicBadge: boolean;
  /** True only for cards that landed live via this session's own digest generation, not ones already on the page from the initial server render — see FrontPage.tsx. Plays a short fade/scale-in. */
  isNew?: boolean;
  /** Stagger offset (seconds) so a multi-card generation reads as cards arriving one after another, not all at once. */
  entranceDelay?: number;
}) {
  const [flipped, setFlipped] = useState(false);
  // The full-report fetch is owned entirely here, not in FocusOverlay —
  // FocusOverlay unmounts on every close (it's conditionally portaled), so
  // any state OR in-flight-request tracking inside it dies with it. That
  // caused two real bugs when the fetch lived there: reopening a card
  // re-flashed a loading state for an already-fetched report (fixed once by
  // lifting `report` here), and — found in review after that first fix —
  // closing the overlay before a slow real Claude call resolved, then
  // reopening, span up a genuine second paid API call, since the fresh
  // FocusOverlay instance had no way to know one was already in flight for
  // this card. Owning the fetch (and its in-flight guard) in NewsCard,
  // which never unmounts across opens/closes, closes both gaps at once —
  // this component is the correct lifetime for "did I already ask for
  // this card's report," not the overlay that merely displays it.
  const [report, setReport] = useState<string | null>(card.expandedReport);
  const [reportError, setReportError] = useState<string | null>(null);
  // Not React state — starting a fetch shouldn't itself trigger a
  // re-render, only the eventual report/error does. Reset to false in the
  // .catch() branch specifically, so a failed fetch can be retried on the
  // next open rather than being permanently stuck.
  const fetchStarted = useRef(false);
  const [bookmarked, setBookmarked] = useState(card.bookmarked);
  const [bookmarkPending, setBookmarkPending] = useState(false);
  // Gates the bookmark glyph's pop animation (below) to real toggles only —
  // false on both the server render and the client's first render (no SSR/
  // hydration divergence, unlike gating on prefersReducedMotion alone,
  // which is null during SSR and would otherwise make a reduced-motion
  // user's server HTML disagree with their client HTML). Flipped true in
  // the same event handler that flips `bookmarked`, so React's automatic
  // batching lands both in the same render — the pop is live from the
  // first real click onward, never on mount.
  const [hasToggledBookmark, setHasToggledBookmark] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const sourcesButtonRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const prevFlipped = useRef(flipped);
  const layoutId = `newscard-${card.id}`;
  // Shared across every card on the page, not local — see
  // FocusModeContext.tsx for why local per-card state can't safely
  // guarantee only one overlay is ever open at a time.
  const { focusedCardId, setFocusedCardId } = useFocusMode();
  const focused = focusedCardId === card.id;
  const prevFocused = useRef(focused);

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

  // Restores focus to the card when focus mode closes, same disclosure-
  // pattern reasoning as the flip effect above — and the same reason it
  // has to be an effect rather than a synchronous call in handleClose:
  // cardRef only points at a real element once React has re-rendered the
  // motion.div back in (it's the placeholder div, with no ref, while
  // focused is still true). Ordering against FocusOverlay's own inert-sweep
  // cleanup (which must un-inert this element before it can accept focus)
  // is guaranteed by React itself, not by timing: FocusOverlay's cleanup
  // runs as part of unmounting that subtree during this same commit, and
  // effects always run after the commit's layout effects have settled —
  // no rAF/timeout guessing required.
  useEffect(() => {
    if (prevFocused.current && !focused) {
      cardRef.current?.focus();
    }
    prevFocused.current = focused;
  }, [focused]);

  // Fires once per card, whenever it's first opened without an existing
  // report — not on mount, so no report is ever fetched for a card that's
  // never actually focused. fetchStarted (not React state) guards against
  // firing a second real request: a genuine re-open before the first
  // request resolves just waits on the same one already running, since
  // `report` will update whenever it lands regardless of whether the
  // overlay happens to be open again by then.
  useEffect(() => {
    if (!focused) return;
    if (report !== null) return;
    if (fetchStarted.current) return;
    fetchStarted.current = true;
    setReportError(null);
    fetch(`/api/cards/${card.id}/expand`, { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error("Couldn't load the full report — try again.");
        return res.json() as Promise<{ expandedReport: string }>;
      })
      .then((data) => setReport(data.expandedReport))
      .catch((e) => {
        setReportError(e instanceof Error ? e.message : "Something went wrong");
        fetchStarted.current = false; // Allow a retry on the next open.
      });
  }, [focused, report, card.id]);

  async function handleBookmarkToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (bookmarkPending) return;
    const next = !bookmarked;
    setHasToggledBookmark(true);
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

  // Guarded on flipped: while showing sources (the back face), the card
  // body isn't displaying story content, so a click there shouldn't also
  // launch focus mode — that's a distinct interaction from Sources, per
  // the design brief.
  function handleOpen() {
    if (flipped) return;
    // Cleared synchronously here, not left to the fetch effect: on a
    // reopen-to-retry after a prior failure, the effect's own
    // setReportError(null) doesn't land until after this render commits,
    // so FocusOverlay would otherwise briefly flash the previous attempt's
    // stale error message before flipping to the loading view.
    setReportError(null);
    setFocusedCardId(card.id);
  }

  function handleOpenKeyDown(e: React.KeyboardEvent) {
    if (flipped) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setReportError(null);
      setFocusedCardId(card.id);
    }
  }

  function handleClose() {
    setFocusedCardId(null);
  }

  return (
    <>
      {focused ? (
        // Placeholder holding the grid cell's geometry: the real content
        // has moved into the portal below, but PageGrid's dense auto-flow
        // would repack every other card into this gap if the DOM node
        // just disappeared, causing a visible reflow behind the overlay.
        <div className={cn(TIER_SPAN[tier], "relative")} aria-hidden />
      ) : (
        <motion.div
          ref={cardRef}
          layoutId={layoutId}
          role="button"
          tabIndex={0}
          onClick={handleOpen}
          onKeyDown={handleOpenKeyDown}
          className={cn(TIER_SPAN[tier], "relative cursor-pointer")}
          style={{ perspective: "1200px" }}
          initial={isNew && !prefersReducedMotion ? { opacity: 0, scale: 0.97 } : false}
          animate={isNew && !prefersReducedMotion ? { opacity: 1, scale: 1 } : undefined}
          // Scoped per-property (not a blanket transition on the whole
          // element) so the entrance's duration/delay can't leak into this
          // same element's OTHER animatable changes — layoutId enables
          // Motion's layout tracking here too, and a bare `transition`
          // prop would otherwise also govern a later grid-position reflow
          // (e.g. a second same-session generation reordering the front
          // page), giving an ordinary layout catch-up a stale entrance delay.
          transition={
            isNew
              ? {
                  opacity: { duration: 0.3, ease: "easeOut", delay: entranceDelay },
                  scale: { duration: 0.3, ease: "easeOut", delay: entranceDelay },
                }
              : undefined
          }
        >
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
                  {/* key={bookmarked} forces a remount on every toggle so the
                      pop-in plays each time, not just on first mount. Gated
                      on hasToggledBookmark (not just prefersReducedMotion,
                      which is null during SSR) so the very first render —
                      server and client alike — never plays this: it's a
                      response to a real state change, not something that
                      should fire just because the card mounted. */}
                  <motion.span
                    key={String(bookmarked)}
                    className="inline-block"
                    initial={hasToggledBookmark && !prefersReducedMotion ? { scale: 0.9 } : false}
                    animate={{ scale: 1 }}
                    transition={{ duration: 0.14, ease: "easeOut" }}
                  >
                    {bookmarked ? "★ Saved" : "☆ Save"}
                  </motion.span>
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
        </motion.div>
      )}

      {focused &&
        createPortal(
          <FocusOverlay
            card={card}
            layoutId={layoutId}
            onClose={handleClose}
            report={report}
            loadingReport={report === null && reportError === null}
            reportError={reportError}
          />,
          document.body
        )}
    </>
  );
}
