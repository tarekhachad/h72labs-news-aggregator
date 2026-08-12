"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Makes everything behind a portaled overlay inert for as long as that
 * overlay is mounted, and moves initial focus into it.
 *
 * A backdrop blocks pointer interaction, but on its own it does nothing for
 * keyboard or screen-reader users — they can still tab into and activate
 * the page underneath. This sweeps every direct child of document.body
 * except the overlay's own portal node (identified by `rootRef`) and sets
 * `inert` on it, restoring each element's previous value on unmount.
 *
 * Extracted from FocusOverlay in Phase 8.2, when the sign-out confirmation
 * became a second consumer. Both callers portal to document.body, which is
 * what makes "every body child except mine" the right scope; a future
 * overlay that portals somewhere else would need a different container,
 * not this hook.
 *
 * Two details that are load-bearing, not stylistic:
 *
 * 1. **useLayoutEffect, not useEffect.** The cleanup (restoring `inert` on
 *    close) must run synchronously during the overlay's unmount commit
 *    rather than on React's async effect schedule, because a caller's own
 *    focus-restoration effect can depend on this ancestor already being
 *    un-inert by the time it runs — focus() is silently ignored on an
 *    inert subtree. React only guarantees that ordering for layout effects.
 *    NewsCard.tsx relies on exactly this when focus mode closes.
 *
 * 2. **Initial focus lives here, in the same effect**, rather than in a
 *    separate one in the caller. Splitting them would leave the ordering
 *    between "background becomes inert" and "focus moves inside" up to
 *    effect declaration order in the component — a footgun, since focusing
 *    an element that a not-yet-excluded sweep has inerted is a silent
 *    no-op. Keeping both in one effect makes the sequence explicit.
 *
 * Only one overlay using this may be open at a time. Two concurrent sweeps
 * would each snapshot the other's mutations as "previous" state and corrupt
 * each other's restore — the exact failure FocusModeContext exists to
 * prevent for focus mode (see its comment). The two current callers are
 * mutually unreachable: the sidebar can't be opened while a card is
 * focused, because this very sweep inerts the Masthead that contains it.
 * (Verified against the real tree: body's only non-portal child is
 * PageTransitionInertBoundary's div, which wraps both the Masthead and all
 * page content — so either sweep covers the other's trigger.)
 *
 * One cross-library ordering dependency worth knowing about, since nothing
 * else records it: when ConfirmDialog opens from inside the sidebar, Base
 * UI's Sheet schedules its own return-focus-to-trigger call for after its
 * exit transition finishes — i.e. *after* this hook has already focused
 * the dialog. That doesn't steal focus only because the trigger is by then
 * inside this sweep's inert subtree, and focus() on an inert element is a
 * spec'd no-op. Reverting this hook to useEffect, or Base UI changing its
 * teardown order, would surface as focus silently jumping to the hamburger
 * button instead of staying on the dialog.
 *
 * @param rootRef      The overlay's own outermost node, excluded from the sweep.
 * @param initialFocusRef Element to focus on open — for a destructive
 *                        confirmation, prefer the non-destructive control.
 */
export function useInertBackground(
  rootRef: RefObject<HTMLElement | null>,
  initialFocusRef?: RefObject<HTMLElement | null>
) {
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

    initialFocusRef?.current?.focus();

    return () => {
      siblings.forEach((el, i) => {
        el.inert = previouslyInert[i];
      });
    };
    // Refs are stable across renders; this must run exactly once per mount,
    // matching the overlay's own lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
