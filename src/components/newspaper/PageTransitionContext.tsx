"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useReducedMotion } from "motion/react";
import { pagesBetween } from "@/lib/pageOrder";

export type TransitionStage = "idle" | "zooming-out" | "flipping" | "zooming-in";

// Exported so PageTransition.tsx's visual animation durations stay in sync
// with the state machine driving them, rather than two independently-tuned
// copies of the same numbers drifting apart.
export const ZOOM_OUT_MS = 300;
export const FLIP_DURATION_MS = 400; // per intervening page flipped through
export const ZOOM_IN_MS = 300;
// Safety valve, not a normal-path duration: if the destination route never
// mounts (a hung fetch, a thrown error before render, anything else that
// keeps pathname from ever matching targetHref), this forces the state
// machine back to idle instead of leaving the full-viewport overlay stuck
// up forever with no escape hatch.
const STALL_TIMEOUT_MS = 8000;

const PageTransitionContext = createContext<{
  stage: TransitionStage;
  flipCount: number;
} | null>(null);

const PageTransitionActionsContext = createContext<{
  /**
   * pageOrder omitted (e.g. the masthead's "go home" link, which per B5's
   * design is always a single hop to "/" regardless of how many topics
   * deep the user is) means "just do a plain single flip," skipping the
   * intervening-pages count entirely — Masthead doesn't need to know the
   * user's topic list just to go home.
   */
  navigate: (href: string, pageOrder?: string[]) => void;
} | null>(null);

/**
 * Drives the full 3D page-flip transition (B8) between newspaper pages —
 * front page <-> topic page, topic <-> topic — per docs/(C) UI_DESIGN.md's
 * "Navigating between pages" section. State machine: idle -> zooming-out ->
 * flipping -> zooming-in -> idle. The destination's actual mount (pathname
 * matching the target), not a fixed timer, gates the flipping->zooming-in
 * transition — a slow destination data-fetch just holds the flip a beat
 * longer instead of popping in unfinished content. Deliberately NOT built
 * on Next 16's experimental View Transitions config (built for simple
 * crossfades, not a bespoke multi-stage flip with a synthetic intervening-
 * pages visual) — fully client-orchestrated with Motion instead.
 */
export function PageTransitionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const prefersReducedMotion = useReducedMotion();
  const [stage, setStage] = useState<TransitionStage>("idle");
  const [flipCount, setFlipCount] = useState(1);
  const [minFlipTimeElapsed, setMinFlipTimeElapsed] = useState(false);
  const targetHref = useRef<string | null>(null);

  // navigate() needs the *current* stage/pathname/router at call time, but
  // must itself keep a stable identity (see the useCallback below) so the
  // actions-context split actually avoids re-rendering Masthead/TopicBand/
  // TopicNavBox on every stage transition — a plain closure over the state
  // variables would defeat that by changing identity every render. Refs,
  // kept in sync after every render, thread the current values through
  // without navigate depending on them.
  const stageRef = useRef(stage);
  const pathnameRef = useRef(pathname);
  const prefersReducedMotionRef = useRef(prefersReducedMotion);
  const routerRef = useRef(router);
  useEffect(() => {
    stageRef.current = stage;
    pathnameRef.current = pathname;
    prefersReducedMotionRef.current = prefersReducedMotion;
    routerRef.current = router;
  });

  const navigate = useCallback((href: string, pageOrder?: string[]) => {
    if (stageRef.current !== "idle") return; // A transition is already in flight — ignore a second click.
    if (href === pathnameRef.current) return; // Already there.

    if (prefersReducedMotionRef.current) {
      routerRef.current.push(href);
      return;
    }

    const steps = pageOrder ? pagesBetween(pathnameRef.current, href, pageOrder) : 1;
    if (steps === null) {
      // Not a flip-eligible page (e.g. somehow not in the given order) —
      // plain navigation rather than guessing a flip count.
      routerRef.current.push(href);
      return;
    }

    targetHref.current = href;
    setFlipCount(Math.max(1, steps));
    // Reset here, in the click handler, not in the "flipping" effect below
    // — setting it there would mean calling setState synchronously at the
    // top of an effect body for no reason it couldn't be done here first.
    setMinFlipTimeElapsed(false);
    setStage("zooming-out");
  }, []);

  // zooming-out -> flipping, after the zoom-out beat plays.
  useEffect(() => {
    if (stage !== "zooming-out") return;
    const timer = setTimeout(() => setStage("flipping"), ZOOM_OUT_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  // Entering "flipping": kick off the real navigation once, and start the
  // minimum-flip-time timer (scaled by flipCount so a multi-page jump's
  // flip reads as genuinely flipping through more pages, not the same
  // duration as a single hop).
  useEffect(() => {
    if (stage !== "flipping") return;
    if (targetHref.current) routerRef.current.push(targetHref.current);
    const timer = setTimeout(() => setMinFlipTimeElapsed(true), flipCount * FLIP_DURATION_MS);
    return () => clearTimeout(timer);
  }, [stage, flipCount]);

  // Stall-safety valve: if the destination route never mounts — a hung
  // fetch, an error thrown before render, anything else that keeps
  // pathname from ever matching targetHref — don't leave the full-viewport
  // overlay stuck up forever with no escape hatch. Force back to idle once
  // this fires; the intended navigation may not have visibly completed,
  // but the app stays usable instead of being wedged behind an opaque page.
  useEffect(() => {
    if (stage !== "flipping") return;
    const timer = setTimeout(() => {
      setStage("idle");
      targetHref.current = null;
    }, STALL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  // flipping -> zooming-in, gated on BOTH the minimum flip time and the
  // destination route having actually mounted (pathname matches target) —
  // whichever finishes last. This is the "no visible pop on a slow fetch"
  // guarantee: a slow destination just holds the flip open longer, it
  // never reveals a half-loaded page.
  useEffect(() => {
    if (stage === "flipping" && minFlipTimeElapsed && pathname === targetHref.current) {
      setStage("zooming-in");
    }
  }, [stage, minFlipTimeElapsed, pathname]);

  // zooming-in -> idle, after the zoom-in beat plays.
  useEffect(() => {
    if (stage !== "zooming-in") return;
    const timer = setTimeout(() => {
      setStage("idle");
      targetHref.current = null;
    }, ZOOM_IN_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  const actionsValue = useMemo(() => ({ navigate }), [navigate]);
  const stateValue = useMemo(() => ({ stage, flipCount }), [stage, flipCount]);

  return (
    <PageTransitionActionsContext.Provider value={actionsValue}>
      <PageTransitionContext.Provider value={stateValue}>
        {children}
      </PageTransitionContext.Provider>
    </PageTransitionActionsContext.Provider>
  );
}

/** Read-only transition state — for PageTransition.tsx's own visual, not for triggering navigation. */
export function usePageTransitionState() {
  const ctx = useContext(PageTransitionContext);
  if (!ctx) throw new Error("usePageTransitionState must be used within a PageTransitionProvider");
  return ctx;
}

/** The navigate() trigger — for Masthead/TopicBand/TopicNavBox's links. */
export function usePageTransitionActions() {
  const ctx = useContext(PageTransitionActionsContext);
  if (!ctx) throw new Error("usePageTransitionActions must be used within a PageTransitionProvider");
  return ctx;
}
