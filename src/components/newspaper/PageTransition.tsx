"use client";

import { createPortal } from "react-dom";
import { motion } from "motion/react";
import {
  usePageTransitionState,
  ZOOM_OUT_MS,
  FLIP_DURATION_MS,
  ZOOM_IN_MS,
} from "@/components/newspaper/PageTransitionContext";

const ZOOM_OUT_SCALE = 0.6;

/**
 * The page-flip's visual: an abstracted "page" — not a screenshot of the
 * real page — that zooms out, flips (flipCount times, for a multi-page
 * jump), then zooms back in once the real destination has actually
 * mounted underneath. Deliberately abstracted rather than capturing real
 * page pixels: a true DOM-snapshot cross-fade (or the browser's View
 * Transitions API, ruled out by the 4.3 plan for exactly this reason)
 * would need to rasterize both the outgoing and incoming pages, which is
 * slow/fragile and unnecessary for what the choreography needs to convey
 * — the audience sees an off-white newspaper-colored page rotate through
 * the transition, not the real content, so the swap underneath is
 * invisible regardless of how it happens. Rendered via a portal so it
 * sits above everything, same technique as FocusOverlay/Backdrop.
 */
export function PageTransition() {
  const { stage, flipCount } = usePageTransitionState();

  if (stage === "idle" || typeof document === "undefined") return null;

  const isZoomingOut = stage === "zooming-out";
  const isFlipping = stage === "flipping";

  const animate = isZoomingOut
    ? { scale: ZOOM_OUT_SCALE, rotateY: 0 }
    : isFlipping
      ? { scale: ZOOM_OUT_SCALE, rotateY: flipCount * 180 }
      : { scale: 1, rotateY: flipCount * 180 }; // zooming-in

  const durationMs = isZoomingOut ? ZOOM_OUT_MS : isFlipping ? flipCount * FLIP_DURATION_MS : ZOOM_IN_MS;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(26,26,26,0.5)" }}
      aria-hidden
    >
      <motion.div
        className="flex flex-col overflow-hidden rounded-md"
        style={{
          width: "60vw",
          height: "70vh",
          background: "var(--color-background)",
          border: "1px solid var(--color-rule)",
          boxShadow: "0 10px 24px rgba(26,26,26,0.16)",
        }}
        initial={{ scale: 1, rotateY: 0 }}
        animate={animate}
        transition={{ duration: durationMs / 1000, ease: "easeInOut" }}
      >
        <div className="h-2 w-full shrink-0" style={{ background: "var(--color-rule)" }} />
        <div className="flex flex-1 flex-col gap-3 p-8">
          <div className="h-6 w-2/3 rounded" style={{ background: "var(--color-muted)" }} />
          <div className="h-3 w-full rounded" style={{ background: "var(--color-muted)" }} />
          <div className="h-3 w-5/6 rounded" style={{ background: "var(--color-muted)" }} />
          <div className="h-3 w-4/6 rounded" style={{ background: "var(--color-muted)" }} />
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
