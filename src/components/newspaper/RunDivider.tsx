"use client";

import { useSyncExternalStore } from "react";
import type { GridPosition } from "@/lib/packGrid";

// No actual external store here — generatedAt is a static prop, not a
// live-updating value, so there's nothing to subscribe to. What we want is
// useSyncExternalStore's getServerSnapshot/getSnapshot split, not its
// subscription mechanism — see RunDivider's doc comment below.
function subscribe() {
  return () => {};
}

function formatTime(generatedAt: string): string {
  return new Date(generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Full-width rule + timestamp marking the boundary between cards added by
 * different same-day generation runs. card.generatedAt is stamped
 * identically across every card in one run (see saveGeneratedCards), so
 * FrontPage.tsx/TopicPage.tsx key run boundaries off it directly via
 * packGridWithRunDividers — no backend change needed.
 *
 * Shows the absolute time of day (not formatRelativeTime's "2h ago"),
 * deliberately: on a /history/[date] page for a past date, two runs from
 * that day could both read as "5d ago" once viewed later, which says
 * nothing about how far apart they actually were — an absolute time stays
 * meaningful regardless of when the page is viewed.
 *
 * `useSyncExternalStore` (not a plain render-time call, not a manual
 * useEffect+useState dance) specifically because `toLocaleTimeString` with
 * no explicit timeZone resolves to the *runtime's* local timezone, which
 * differs between the server (UTC on Vercel) and a real visitor's browser
 * — a genuine SSR/hydration mismatch on FrontPage.tsx specifically, since
 * it's a Client Component that's also server-rendered (initialDigest.cards
 * arrives via props, so a divider can appear on a page's very first
 * server-rendered HTML, not just live during generation). "Local time" is
 * also the semantically correct choice regardless of the hydration
 * concern — the whole point of a wall-clock label is that it should read
 * in the *viewer's* own timezone, which can only genuinely be known
 * client-side. `getServerSnapshot` returning null is exactly React's own
 * mechanism for "render this during SSR/first paint, reconcile to the
 * real environment-dependent value immediately after" — the same class of
 * problem this codebase already solves with a plain state+effect fallback
 * elsewhere (NewsCard's hasToggledBookmark, useDynamicLineClamp), but
 * `useSyncExternalStore` is the more direct tool for a value that's
 * genuinely a snapshot of ambient environment state rather than something
 * that becomes true in response to a React event.
 */
export function RunDivider({ generatedAt, gridPosition }: { generatedAt: string; gridPosition?: GridPosition }) {
  const time = useSyncExternalStore(
    subscribe,
    () => formatTime(generatedAt),
    () => null
  );

  return (
    <div className="flex h-full items-center gap-3" style={gridPosition} role="separator">
      <div className="h-px flex-1" style={{ background: "var(--color-border)" }} />
      <span
        className="shrink-0 text-xs font-medium tracking-wide"
        style={{ color: "var(--color-muted-foreground)" }}
      >
        {time ? `Added at ${time}` : "Added"}
      </span>
      <div className="h-px flex-1" style={{ background: "var(--color-border)" }} />
    </div>
  );
}
