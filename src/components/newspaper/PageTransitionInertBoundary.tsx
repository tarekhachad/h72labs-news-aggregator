"use client";

import { useEffect, useRef } from "react";
import { usePageTransitionState } from "@/components/newspaper/PageTransitionContext";

/**
 * Marks the masthead and the real page content inert while a page-flip
 * transition is in flight, and restores keyboard focus once it completes.
 * PageTransition.tsx's overlay is aria-hidden and blocks pointer events by
 * covering the viewport, but neither of those stops a keyboard or
 * screen-reader user from tabbing into and activating real content hidden
 * behind it — DOM focus traversal doesn't respect visual stacking. Same
 * reachability gap already fixed for the Sources flip (B6) and focus mode
 * (B7), applied here for the same reason.
 *
 * Marking an element inert forcibly blurs it if it held focus (part of the
 * `inert` spec) — and since navigate() is normally triggered by clicking a
 * link that then gets marked inert mid-flip, and the destination page
 * replaces the source page's DOM entirely, the clicked link itself won't
 * exist afterward to refocus (unlike FocusOverlay's return-to-trigger
 * pattern, which never navigates away). Focus is moved to the wrapper around
 * the page content once the flip lands instead — the standard "focus main
 * content after a route change" pattern — so keyboard/screen-reader users
 * land on the new page rather than silently stranded on <body>.
 *
 * The masthead is a separate prop, not part of `children`, so that the inert
 * wrapper can cover both while the focus target covers only the page: a
 * focus target that also wrapped the masthead would send the next Tab back
 * through the hamburger and title before reaching the page that just
 * arrived.
 */
export function PageTransitionInertBoundary({
  masthead,
  children,
}: {
  masthead: React.ReactNode;
  children: React.ReactNode;
}) {
  const { stage } = usePageTransitionState();
  const isInert = stage !== "idle";
  const contentRef = useRef<HTMLDivElement>(null);
  const wasTransitioning = useRef(false);

  useEffect(() => {
    if (isInert) {
      wasTransitioning.current = true;
    } else if (wasTransitioning.current) {
      wasTransitioning.current = false;
      contentRef.current?.focus();
    }
  }, [isInert]);

  return (
    <div className="min-h-screen" inert={isInert}>
      {masthead}
      <div ref={contentRef} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
