"use client";

import { useLayoutEffect, useState } from "react";

/**
 * Measures how many lines of `summaryRef`'s text can render without
 * overflowing the space between its own top and `footerRef`'s top, then
 * returns that as `clampLines`. Relies on `footerRef` being pinned to the
 * bottom of `faceRef` via `mt-auto` in a fixed-height flex column: as long
 * as content fits (guaranteed by NewsCard rendering the safe static
 * fallback clamp until this first measurement lands), the footer's
 * position is invariant to the summary's own height, so a single
 * offsetTop diff — no iteration, no analytical box-model math over
 * padding/margins/gaps — gives the true available height regardless of the
 * summary's current clamp level.
 *
 * Deliberately `offsetTop` (layout-box position relative to `faceRef`, the
 * nearest positioned ancestor both children share), not
 * `getBoundingClientRect()`: NewsCard's outer wrapper shares a Motion
 * `layoutId` with FocusOverlay, and closing focus mode plays a ~0.4s
 * shared-element transition back down to the grid cell via CSS `transform`
 * — which `getBoundingClientRect()` reports (it's the *visual* rect,
 * transform included) but doesn't change the element's actual layout box,
 * so `ResizeObserver` never fires again to correct a reading taken mid-
 * animation. An earlier version of this hook used
 * `getBoundingClientRect()` and reproducibly measured a card at ~2x its
 * true size (matching the overlay's near-fullscreen transform) the instant
 * after a focus-mode close, then stayed wrong forever — live-verified via
 * Playwright, not just reasoned about. `offsetTop` reads the untransformed
 * layout position directly, so it's correct throughout the animation, not
 * just after it settles.
 *
 * `clampLines` starts `null` (server render + first client paint) so the
 * caller can render its existing static per-tier clamp until a real
 * measurement is available — mirrors NewsCard's own `hasToggledBookmark`
 * pattern for the same SSR/hydration-mismatch hazard. useLayoutEffect (not
 * useEffect), matching FocusOverlay's precedent elsewhere in this
 * codebase, so the measured value commits before paint instead of
 * flashing the fallback clamp first.
 *
 * The three refs are state-backed callback refs, not plain `useRef`s: the
 * caller (NewsCard) unmounts/remounts this whole DOM subtree every time
 * focus mode opens/closes (a placeholder swaps in for the real face — see
 * NewsCard's own comment on why), and a one-shot `useRef` + effect-with-
 * empty-deps would keep observing the original, now-detached node forever
 * after the first such round-trip, silently freezing that card's clamp
 * against all future layout changes. Callback refs make the effect re-run
 * (and the ResizeObserver re-attach) every time the underlying node
 * identity actually changes, mount or remount alike.
 */
export function useDynamicLineClamp() {
  const [face, setFace] = useState<HTMLDivElement | null>(null);
  const [summary, setSummary] = useState<HTMLParagraphElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [clampLines, setClampLines] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!face || !summary || !footer) return;

    function measure() {
      if (!summary || !footer) return;
      const lineHeight = parseFloat(getComputedStyle(summary).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      const availableHeight = footer.offsetTop - summary.offsetTop;
      setClampLines(Math.max(1, Math.floor(availableHeight / lineHeight)));
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(face);
    return () => observer.disconnect();
  }, [face, summary, footer]);

  return { faceRef: setFace, summaryRef: setSummary, footerRef: setFooter, clampLines };
}
