"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import type { Card } from "@/types";
import { formatRelativeTime } from "@/lib/time";
import type { GridTier } from "@/lib/gridTiers";
import type { GridPosition } from "@/lib/packGrid";
import { cn } from "@/lib/utils";
import { FocusOverlay } from "@/components/newspaper/FocusOverlay";
import { useFocusMode } from "@/components/newspaper/FocusModeContext";
import { labelColor } from "@/lib/labelColor";
import { useDynamicLineClamp } from "@/hooks/useDynamicLineClamp";
import { ENTRANCE_DURATION_SECONDS } from "@/lib/entranceTiming";

// Card.shortSummary is one 2-4 sentence paragraph (not a separate
// headline + body) — font-size/line-height still come from this per-tier
// table, but the actual clamp *length* is measured live by
// useDynamicLineClamp (5.6) against the real title/label-chip/footer rows
// rendered below, not a fixed guess. FALLBACK_CLAMP_LINES are that hook's
// pre-measurement values (the exact numbers this table held before 5.6 —
// deliberately conservative, verified live not to overflow) — rendered
// until the client measurement effect lands, same SSR-safety pattern as
// this component's own hasToggledBookmark.
const TEXT_SIZE_CLASS: Record<GridTier, string> = {
  hero: "text-2xl leading-snug",
  medium: "text-lg leading-snug",
  small: "text-sm leading-snug",
};

const FALLBACK_CLAMP_LINES: Record<GridTier, number> = {
  hero: 4,
  medium: 4,
  small: 1,
};

// Title sizing/clamping mirrors TEXT_CLASS's tier philosophy — smaller
// tiers get a smaller font and less room to wrap, matching how much
// space each tier's box actually has for a second content row above the
// summary.
const TITLE_CLASS: Record<GridTier, string> = {
  hero: "font-heading text-xl font-bold leading-tight line-clamp-2",
  medium: "font-heading text-base font-bold leading-tight line-clamp-2",
  small: "font-heading text-sm font-bold leading-tight line-clamp-1",
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
  gridPosition,
  showTopicBadge,
  showNewBadge = false,
  animateEntrance = false,
  entranceDelay = 0,
  onEntrancePlayed,
}: {
  card: Card;
  tier: GridTier;
  /** This card's explicit grid-column/grid-row placement, computed by packGrid.ts (see FrontPage.tsx/TopicPage.tsx) — replaces tier-driven Tailwind span classes so a row can be widened to close a gap. Undefined only if packGrid didn't return a position for this id (shouldn't happen; PageGrid's `dense` auto-flow is kept as a defensive fallback for exactly this case). */
  gridPosition?: GridPosition;
  /** Front page spans multiple topics (badge needed); a topic page's cards are all the same topic (badge is redundant there). */
  showTopicBadge: boolean;
  /**
   * Renders the "New" chip: this card came from the most recent generation
   * run on a page that holds cards from more than one (see newRun.ts).
   * Deliberately distinct from `animateEntrance` below, which is about this
   * session rather than about the data — reload the page after a second run
   * and the badge stays while the entrance animation does not.
   */
  showNewBadge?: boolean;
  /** True only for cards that landed live via this session's own digest generation, not ones already on the page from the initial server render — see FrontPage.tsx. Plays a short fade/scale-in. */
  animateEntrance?: boolean;
  /** Stagger offset (seconds) so a multi-card generation reads as cards arriving one after another, not all at once. Must stay fixed for a given card — a changing value is a changing Motion transition, which re-triggers the entrance. */
  entranceDelay?: number;
  /** Called once this card's entrance animation finishes, so the owner can retire it and never play it again (see DigestGenerationContext's pendingEntrances). */
  onEntrancePlayed?: (cardId: string) => void;
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
  // Real state, not derived from `report`/`reportError` being empty: since
  // Phase 8.3 gated generation behind a button, "not requested yet" and
  // "request in flight" are genuinely different states that both have a
  // null report. The overlay shows a button for the first and a progress
  // line for the second.
  const [loadingReport, setLoadingReport] = useState(false);
  // Not React state — the synchronous in-flight guard. See
  // handleGenerateReport below for why both this and loadingReport exist.
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
  const { faceRef, summaryRef, footerRef, clampLines } = useDynamicLineClamp();

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

  // Explicitly user-triggered as of Phase 8.3 — this used to be an effect
  // keyed on `focused`, so merely opening focus mode spent a Sonnet call.
  // Opening a card is often just how you read the *short* summary in full
  // (the grid clamps it to fit), which made the old behavior pay for a
  // report the reader never asked to see. Now the overlay shows a button
  // and nothing is generated until it's pressed.
  //
  // Two overlapping guards, deliberately:
  //   - `report !== null` — already have it, from a seed or an earlier
  //     generation. No request, and the overlay renders it directly.
  //     Checked against null rather than falsiness so a legitimately
  //     empty report still counts as generated; FocusOverlay's render
  //     branches on `!== null` too, and the two must agree or the button
  //     shows for a card this guard then refuses to generate.
  //   - `fetchStarted` (a ref, not state) — synchronous, so two clicks
  //     landing in the same batch can't both get past it. `loadingReport`
  //     also disables the button, but state updates are async and that
  //     alone can't rule out a double-fire. Getting this wrong means
  //     paying Anthropic twice for one report.
  // Reset in the catch so a failure is retryable, in place, from the
  // button — which no longer requires closing and reopening the card.
  async function handleGenerateReport() {
    if (report !== null) return;
    if (fetchStarted.current) return;
    fetchStarted.current = true;
    setLoadingReport(true);
    setReportError(null);
    try {
      const res = await fetch(`/api/cards/${card.id}/expand`, { method: "POST" });
      if (!res.ok) throw new Error("Couldn't load the full report — try again.");
      const data = (await res.json()) as { expandedReport: string };
      setReport(data.expandedReport);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : "Something went wrong");
      fetchStarted.current = false;
    } finally {
      setLoadingReport(false);
    }
  }

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

  // Stops a keydown from bubbling to the card's own onKeyDown below, the
  // keyboard equivalent of the e.stopPropagation() every interactive
  // element's onClick already does. Without this, focusing e.g. the
  // Sources button and pressing Enter/Space fires the *card's*
  // handleOpenKeyDown first (native keydown bubbles before the browser
  // synthesizes the button's own click), which used to just no-op while
  // flipped but — now that it actively flips the card back — would also
  // wrongly intercept Enter on a focused source link (blocking its
  // navigation) or the Save button (opening focus mode instead of
  // toggling the bookmark). Only Enter/Space are stopped, matching exactly
  // what handleOpenKeyDown itself reacts to; every other key still bubbles
  // normally.
  function stopEnterSpacePropagation(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  }

  // Guarded on flipped: while showing sources (the back face), a click on
  // the card body flips it back to the front instead of launching focus
  // mode — that's a distinct interaction from Sources, per the design
  // brief. No double-toggle risk: handleFlip and the Back button/source
  // links all call e.stopPropagation() (and, via stopEnterSpacePropagation
  // above, its keyboard equivalent), so this only ever fires for an
  // interaction with the back face's own non-interactive area.
  function openOrFlipBack() {
    if (flipped) {
      setFlipped(false);
      return;
    }
    // A previous failure's error is deliberately NOT cleared here. It used
    // to be, because reopening immediately re-fired the fetch effect and
    // the stale message would flash before the loading view replaced it.
    // Nothing auto-fires on open any more (Phase 8.3), so the error simply
    // stays visible alongside a "Try again" button — which is the useful
    // thing to show someone reopening a card whose report failed.
    //
    // Retire the entrance early: opening focus mode swaps this card's
    // motion.div for a placeholder, and Motion clears its event
    // subscriptions on unmount, so a card opened *while still animating
    // in* would never fire onAnimationComplete. The provider retires it on
    // a timer regardless, so this is only about retiring it promptly —
    // having looked at a card is reason enough to stop treating it as
    // just-arrived.
    onEntrancePlayed?.(card.id);
    setFocusedCardId(card.id);
  }

  function handleOpenKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openOrFlipBack();
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
        <div className="relative" style={gridPosition} aria-hidden />
      ) : (
        <motion.div
          ref={cardRef}
          layoutId={layoutId}
          // Constant on purpose (card.id never changes for a mounted
          // instance) — this card's own reposition (e.g. a grid repack from
          // a live digest generation adding cards) should never self-
          // animate; the only intended animation off this layoutId is the
          // mount/unmount handoff to FocusOverlay, which Motion tracks via
          // componentWillUnmount regardless of layoutDependency. See Phase 6.5.
          layoutDependency={card.id}
          role="button"
          tabIndex={0}
          onClick={openOrFlipBack}
          onKeyDown={handleOpenKeyDown}
          className="relative cursor-pointer"
          style={{ ...gridPosition, perspective: "1200px" }}
          initial={animateEntrance && !prefersReducedMotion ? { opacity: 0, scale: 0.97 } : false}
          animate={animateEntrance && !prefersReducedMotion ? { opacity: 1, scale: 1 } : undefined}
          // Retires this card's entrance the moment it finishes — the
          // common, tidy path. This only ever fires for the entrance's own
          // opacity/scale animation: Motion raises a separate
          // LayoutAnimationComplete event for the `layout` projection, so
          // the instant reflow above can't trigger it (verified in
          // motion-dom's VisualElement source). Every case where it can't
          // fire — reduced motion, an interrupting unmount — is caught by
          // the provider's own timer instead, so nothing here needs to be
          // exhaustive.
          onAnimationComplete={
            animateEntrance && !prefersReducedMotion
              ? () => onEntrancePlayed?.(card.id)
              : undefined
          }
          // Scoped per-property (not a blanket transition on the whole
          // element) so the entrance's duration/delay can't leak into this
          // same element's OTHER animatable changes — layoutId enables
          // Motion's layout tracking here too, and a bare `transition`
          // prop would otherwise also govern a later grid-position reflow
          // (e.g. a second same-session generation reordering the front
          // page), giving an ordinary layout catch-up a stale entrance delay.
          // `layout` is always present (not just when animateEntrance): whichever
          // motion.div is newly mounting in a shared-layoutId handoff reads
          // its OWN transition, never the other side's — FocusOverlay's own
          // duration:0 (Phase 6.3) only covers the open direction. On close,
          // this element is the one remounting, so without an explicit
          // `layout` override here it fell back to Motion's default 0.45s
          // eased tween, animating the exit even though entry was instant.
          transition={{
            layout: { duration: 0 },
            ...(animateEntrance
              ? {
                  opacity: {
                    duration: ENTRANCE_DURATION_SECONDS,
                    ease: "easeOut",
                    delay: entranceDelay,
                  },
                  scale: {
                    duration: ENTRANCE_DURATION_SECONDS,
                    ease: "easeOut",
                    delay: entranceDelay,
                  },
                }
              : {}),
          }}
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
              ref={faceRef}
              className="absolute inset-0 flex flex-col overflow-hidden rounded-md p-5"
              style={{ ...CARD_FACE_STYLE, backfaceVisibility: "hidden" }}
              inert={flipped}
            >
              <div className="flex items-center justify-between gap-2">
                {/* A left-hand group rather than the old
                    `showTopicBadge ? chip : <span />` placeholder: the
                    placeholder existed only to keep justify-between pushing
                    the timestamp right on topic pages, and it couldn't hold
                    a second chip. This handles all four combinations of
                    topic-chip × New-badge, including the topic-page case
                    where the badge shows and the topic chip doesn't. An
                    empty group is zero-width, so alignment is unchanged. */}
                <div className="flex min-w-0 items-center gap-1.5">
                  {showTopicBadge && (
                    <span
                      className="w-fit truncate rounded px-2 py-0.5 text-xs font-semibold"
                      style={{
                        background: "var(--color-muted)",
                        color: "var(--color-muted-foreground)",
                      }}
                    >
                      {card.topic}
                    </span>
                  )}
                  {/* The literal string "New", never a formatted time.
                      FrontPage is a client component that is also
                      server-rendered, so any locale- or timezone-dependent
                      text here would reintroduce the exact SSR/hydration
                      mismatch that forced RunDivider to use
                      useSyncExternalStore in Phase 5.7 — the component this
                      badge replaced. shrink-0 so a long topic name
                      truncates instead of squeezing the badge out. */}
                  {showNewBadge && (
                    <span
                      className="w-fit shrink-0 rounded px-2 py-0.5 text-xs font-semibold"
                      style={{
                        background: "var(--color-accent)",
                        color: "var(--color-on-accent)",
                      }}
                    >
                      New
                    </span>
                  )}
                </div>
                <span
                  className="shrink-0 text-xs"
                  style={{ color: "var(--color-muted-foreground)" }}
                >
                  {formatRelativeTime(card.publishedAt)}
                </span>
              </div>

              {/* Empty for a pre-5.5 row (rowToCard's ?? "" fallback) — no
                  title to render rather than an empty, oddly-spaced line. */}
              {card.title && <p className={cn(TITLE_CLASS[tier], "mt-3")}>{card.title}</p>}

              {card.labels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {card.labels.map((label, i) => {
                    const { background, color } = labelColor(label);
                    return (
                      <span
                        key={`${label}-${i}`}
                        className="w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background, color }}
                      >
                        {label}
                      </span>
                    );
                  })}
                </div>
              )}

              <p
                ref={summaryRef}
                className={cn(
                  TEXT_SIZE_CLASS[tier],
                  "mt-2 overflow-hidden font-semibold [-webkit-box-orient:vertical] [display:-webkit-box]"
                )}
                style={{ WebkitLineClamp: clampLines ?? FALLBACK_CLAMP_LINES[tier] }}
              >
                {card.shortSummary}
              </p>

              <div ref={footerRef} className="mt-auto flex items-center gap-4 pt-3">
                <button
                  type="button"
                  onClick={handleBookmarkToggle}
                  onKeyDown={stopEnterSpacePropagation}
                  disabled={bookmarkPending}
                  className="cursor-pointer text-xs font-medium underline transition-colors hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
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
                  onKeyDown={stopEnterSpacePropagation}
                  aria-expanded={flipped}
                  className="-mx-1.5 -my-0.5 cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium underline transition-colors hover:bg-[var(--color-muted)]"
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
                  onKeyDown={stopEnterSpacePropagation}
                  className="-mx-1.5 -my-0.5 cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium underline transition-colors hover:bg-[var(--color-muted)]"
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
                      onKeyDown={stopEnterSpacePropagation}
                      className="underline underline-offset-2 transition-all hover:text-[var(--color-accent)] hover:underline-offset-4"
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
            loadingReport={loadingReport}
            reportError={reportError}
            onGenerateReport={handleGenerateReport}
          />,
          document.body
        )}
    </>
  );
}
