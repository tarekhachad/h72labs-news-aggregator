"use client";

import { useEffect, useRef } from "react";
import { usePageTransitionState } from "@/components/newspaper/PageTransitionContext";

/**
 * Marks the real page content inert while a page-flip transition is in
 * flight, and restores keyboard focus once it completes. PageTransition.tsx's
 * overlay is aria-hidden and blocks pointer events by covering the viewport,
 * but neither of those stops a keyboard or screen-reader user from tabbing
 * into and activating real content hidden behind it — DOM focus traversal
 * doesn't respect visual stacking. Same reachability gap already fixed for
 * the Sources flip (B6) and focus mode (B7), applied here for the same
 * reason.
 *
 * Marking an element inert forcibly blurs it if it held focus (part of the
 * `inert` spec) — and since navigate() is normally triggered by clicking a
 * link that then gets marked inert mid-flip, and the destination page
 * replaces the source page's DOM entirely, the clicked link itself won't
 * exist afterward to refocus (unlike FocusOverlay's return-to-trigger
 * pattern, which never navigates away). Focus is moved to this boundary's
 * own root once the flip lands instead — the standard "focus main content
 * after a route change" pattern — so keyboard/screen-reader users land
 * somewhere deliberate on the new page rather than silently stranded on
 * <body>.
 */
export function PageTransitionInertBoundary({ children }: { children: React.ReactNode }) {
  const { stage } = usePageTransitionState();
  const isInert = stage !== "idle";
  const rootRef = useRef<HTMLDivElement>(null);
  const wasTransitioning = useRef(false);

  useEffect(() => {
    if (isInert) {
      wasTransitioning.current = true;
    } else if (wasTransitioning.current) {
      wasTransitioning.current = false;
      rootRef.current?.focus();
    }
  }, [isInert]);

  return (
    <div ref={rootRef} className="min-h-screen" inert={isInert} tabIndex={-1}>
      {children}
    </div>
  );
}
