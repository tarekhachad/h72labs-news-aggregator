"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import type { Card } from "@/types";
import { Backdrop } from "@/components/newspaper/Backdrop";

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
}: {
  card: Card;
  layoutId: string;
  onClose: () => void;
  report: string | null;
  loadingReport: boolean;
  reportError: string | null;
}) {
  const prefersReducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Everything behind the overlay becomes inert while it's open — a
  // backdrop blocks pointer interaction, but without this, keyboard/screen
  // reader users could still tab into and interact with the page
  // underneath (the same reachability gap B6's review caught for the
  // Sources flip, applied here proactively). rootRef marks this portal's
  // own DOM node so it's excluded from the inert sweep of body's children.
  // useLayoutEffect, not useEffect: its cleanup (restoring inert on close)
  // must run synchronously during this subtree's unmount commit, not on
  // its own async schedule — NewsCard's own focus-restoration effect
  // depends on this ancestor already being un-inert by the time it runs,
  // and React only guarantees that ordering for layout effects.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const siblings = Array.from(document.body.children).filter(
      (el) => el !== root
    ) as HTMLElement[];
    const previouslyInert = siblings.map((el) => el.inert);
    siblings.forEach((el) => {
      el.inert = true;
    });
    closeButtonRef.current?.focus();
    return () => {
      siblings.forEach((el, i) => {
        el.inert = previouslyInert[i];
      });
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div ref={rootRef}>
      <Backdrop onClick={onClose} />
      <motion.div
        layoutId={layoutId}
        transition={{ duration: prefersReducedMotion ? 0 : 0.4, ease: "easeInOut" }}
        className="fixed top-[12.5%] left-[12.5%] z-50 flex h-3/4 w-3/4 flex-col overflow-hidden rounded-md p-8"
        style={{
          background: "var(--color-card)",
          color: "var(--color-card-foreground)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 10px 24px rgba(26,26,26,0.16)",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={card.shortSummary}
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

        <h2 className="font-heading mt-4 text-3xl font-bold">{card.shortSummary}</h2>

        <div className="mt-4 flex-1 overflow-y-auto">
          {loadingReport && (
            <p className="text-sm" style={{ color: "var(--color-muted-foreground)" }}>
              Loading the full report…
            </p>
          )}
          {reportError && (
            <p className="text-sm" style={{ color: "var(--color-destructive)" }}>
              {reportError}
            </p>
          )}
          {report && <p className="whitespace-pre-line text-base leading-7">{report}</p>}
        </div>
      </motion.div>
    </div>
  );
}
