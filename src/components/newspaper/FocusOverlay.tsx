"use client";

import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
import type { Card } from "@/types";
import { Button } from "@/components/ui/button";
import { Backdrop } from "@/components/newspaper/Backdrop";
import { useInertBackground } from "@/hooks/useInertBackground";

/**
 * The zoom/blur "focus mode" panel — clicking a card's body (not Sources,
 * not Save) opens this to ~75% of the viewport with the full lazy-fetched
 * report, per docs/(C) UI_DESIGN.md's Focus mode section. Rendered via a
 * portal from NewsCard.tsx directly to document.body, sharing a `layoutId`
 * with the small in-grid card so Motion animates the size/position change
 * as a single continuous zoom rather than a generic fade-in.
 *
 * Purely a display component — it owns no fetch logic of its own. The
 * report fetch (and its in-flight/retry bookkeeping) lives entirely in
 * NewsCard.tsx, which stays mounted across opens/closes; this component
 * unmounts on every close (it's conditionally portaled), so anything
 * stateful living here previously caused real bugs: a reopen re-flashing
 * a loading state for an already-fetched report, and — worse — closing
 * before a slow real Claude call resolved, then reopening, firing a
 * genuine second paid API call because the fresh instance had no way to
 * know one was already in flight for this card.
 */
export function FocusOverlay({
  card,
  layoutId,
  onClose,
  report,
  loadingReport,
  reportError,
  onGenerateReport,
}: {
  card: Card;
  layoutId: string;
  onClose: () => void;
  report: string | null;
  loadingReport: boolean;
  reportError: string | null;
  /**
   * Starts the (paid) report generation. Owned by NewsCard, which outlives
   * this component — see the note above about why no fetch state lives
   * here. Safe to call more than once; NewsCard guards it.
   */
  onGenerateReport: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reportRef = useRef<HTMLParagraphElement>(null);
  const prevReport = useRef(report);

  // Everything behind the overlay becomes inert while it's open, and focus
  // moves to the close button. Extracted to a shared hook in Phase 8.2
  // when ConfirmDialog became a second consumer — the behavior here is
  // unchanged, including the useLayoutEffect timing NewsCard's own
  // focus-restoration effect depends on. See the hook for why that timing
  // and the single-open-overlay constraint are load-bearing.
  useInertBackground(rootRef, closeButtonRef);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // When a generated report lands, the button the user pressed unmounts
  // (the render below swaps the whole branch for the report text), which
  // would drop focus to <body> at the moment of success. Move it onto the
  // report itself instead — that's the thing they asked to read.
  //
  // Gated on a null→non-null transition, not merely on `report` being
  // present, so a card that already had a report when the overlay opened
  // doesn't have focus yanked off the close button on mount. Comparing
  // against the previous value rather than using a one-shot flag matches
  // the idiom NewsCard already uses for its flip/focus effects, and is
  // idempotent under React Strict Mode's double invocation.
  useEffect(() => {
    if (prevReport.current === null && report !== null) {
      reportRef.current?.focus();
    }
    prevReport.current = report;
  }, [report]);

  return (
    <div ref={rootRef}>
      <Backdrop onClick={onClose} />
      <motion.div
        layoutId={layoutId}
        // Instant switch, per Tarek's request — the zoom/blur animation
        // read as too slow/heavy. layoutId stays intact so the shared-
        // element handoff from NewsCard's grid cell still works, it just
        // resolves in one frame instead of animating.
        transition={{ duration: 0 }}
        className="fixed top-[12.5%] left-[12.5%] z-50 flex h-3/4 w-3/4 flex-col overflow-hidden rounded-md p-8"
        style={{
          background: "var(--color-card)",
          color: "var(--color-card-foreground)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 10px 24px rgba(26,26,26,0.16)",
        }}
        role="dialog"
        aria-modal="true"
        // card.title (Phase 5.5) — a real headline, not shortSummary (a full
        // paragraph) doing double duty as one. Falls back to shortSummary
        // only for a pre-5.5 card, whose title is "" (rowToCard's fallback).
        aria-label={card.title || card.shortSummary}
      >
        <div className="flex items-start justify-between gap-4">
          <span
            className="w-fit rounded px-2 py-0.5 text-xs font-semibold"
            style={{ background: "var(--color-muted)", color: "var(--color-muted-foreground)" }}
          >
            {card.topic}
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer"
            style={{ color: "var(--color-muted-foreground)" }}
          >
            <X className="size-5" />
          </button>
        </div>

        {/* card.title (Phase 5.5), falling back to shortSummary only for a
            pre-5.5 card (title === "") — previously this always rendered
            the full paragraph as the headline, since no real title field
            existed yet. */}
        <h2 className="font-heading mt-4 text-3xl font-bold">{card.title || card.shortSummary}</h2>

        <div className="mt-4 flex-1 overflow-y-auto">
          {card.title && (
            <p className="mb-4 text-base leading-7" style={{ color: "var(--color-muted-foreground)" }}>
              {card.shortSummary}
            </p>
          )}
          {/* `report !== null`, not a truthy check: a report that came back
              as an empty string is still a report that exists and must not
              be offered for generation again — handleGenerateReport's own
              guard treats it that way, and a truthy check here would
              disagree with it, leaving a "Generate full report" button that
              does nothing when pressed. */}
          {report !== null ? (
            // tabIndex={-1} so the effect above can move focus here when a
            // report lands — otherwise the button the user just pressed
            // unmounts and focus falls to <body>.
            //
            // outline-none is a deliberate call, not an oversight: focus
            // arrives here programmatically and only to place the reading
            // position (and to give screen readers something to announce),
            // never from tabbing. A focus ring drawn around a multi-
            // paragraph block of body text reads as a rendering fault
            // rather than an affordance, and there's nothing here to
            // activate that a ring would be signposting.
            <p
              ref={reportRef}
              tabIndex={-1}
              className="whitespace-pre-line text-base leading-7 outline-none"
            >
              {report}
            </p>
          ) : (
            // No live-region role anywhere in this branch — announcements
            // are handled by the single persistent region below, outside
            // the ternary. Roles here would nest a live region inside a
            // live region, which screen readers handle inconsistently
            // (some announce once, some twice).
            <div className="flex flex-col items-start gap-3">
              {/* Hidden while a retry is in flight, so a stale failure
                  isn't sitting under a button that's already working. */}
              {reportError && (
                <p className="text-sm" style={{ color: "var(--color-destructive)" }}>
                  {reportError}
                </p>
              )}
              {/* focusableWhenDisabled is load-bearing, not decoration.
                  Base UI's Button renders a REAL `disabled` attribute by
                  default, and disabling the element that currently has
                  focus makes the browser blur it to <body> — the same
                  symptom as unmounting it, which is what this branch was
                  restructured to avoid in the first place. With this prop
                  it emits `aria-disabled` instead and stays focusable,
                  while useButton's own onClick still hard-blocks the
                  press. Verified in @base-ui/react's useFocusableWhenDisabled
                  and use-button source, not assumed. */}
              <Button
                variant="outline"
                onClick={onGenerateReport}
                disabled={loadingReport}
                focusableWhenDisabled
                aria-busy={loadingReport}
                className="cursor-pointer"
              >
                {loadingReport
                  ? "Writing the full report…"
                  : reportError
                    ? "Try again"
                    : "Generate full report"}
              </Button>
              {loadingReport && (
                <p className="text-sm" style={{ color: "var(--color-muted-foreground)" }}>
                  This usually takes a few seconds.
                </p>
              )}
            </div>
          )}

          {/* The overlay's one live region, mounted for its entire
              lifetime regardless of report state, so every announcement
              is a text mutation inside a region that already exists —
              the only form screen readers handle consistently. Nothing
              else in here carries a live-region role, so there's no
              nesting to disagree about.

              It is deliberately silent on two transitions. On mount it
              renders whatever the current state is, which for a reopened
              card that previously failed means the region appears already
              populated — the unreliable case, but also the one that needs
              no live announcement at all, since opening a dialog already
              announces itself and the user is about to explore it. And on
              success it stays empty, because focus moves onto the report
              text, which the screen reader reads instead; announcing here
              too would say it twice. */}
          <p aria-live="polite" className="sr-only">
            {loadingReport
              ? "Writing the full report. This usually takes a few seconds."
              : (reportError ?? "")}
          </p>
        </div>
      </motion.div>
    </div>
  );
}
