"use client";

import Link from "next/link";
import type { Topic } from "@/types";
import { topicToSlug } from "@/lib/topicSlug";
import { buildPageOrder } from "@/lib/pageOrder";
import { usePageTransitionActions } from "@/components/newspaper/PageTransitionContext";

/**
 * Flat, centered horizontal band of topic links — the primary way to move
 * between the front page and topic pages (see docs/(C) UI_DESIGN.md's
 * Front page / Topic navigation sections). Selecting a topic triggers the
 * page-flip transition (B8). Replaces the former TopicBand (front page)
 * and TopicNavBox (topic page's dropdown) — both shared ~80% of this
 * logic already, the only real difference being data-driven (whether
 * there's an active topic to render inert and a "Front Page" entry to
 * prepend), not behavioral.
 */
export function TopicNav({
  topics,
  basePath = "",
  activeTopic,
  digestExistsToday = true,
}: {
  topics: Topic[];
  /** "/history/2026-08-01" when this band is on a past date's page, so its links stay scoped to that date instead of jumping to today. */
  basePath?: string;
  /** Set on a topic page (the topic currently being viewed, rendered as inert styled text instead of a link); undefined on the front page. */
  activeTopic?: Topic;
  /** False only on the live front page / topic routes before today's first digest exists — greys out sibling topic links, since those pages would otherwise render empty. Defaults true so every history caller (which never passes this prop) stays ungated — a digest always exists there by construction. */
  digestExistsToday?: boolean;
}) {
  const { navigate } = usePageTransitionActions();

  // Matches TopicBand's original front-page behavior: no topics selected,
  // no band to show. Doesn't apply on a topic page (activeTopic set) —
  // there's always at least "Front Page" + the current topic to show.
  if (topics.length === 0 && activeTopic === undefined) return null;

  const pageOrder = buildPageOrder(topics, basePath);
  const frontPageHref = basePath || "/";

  function handleClick(e: React.MouseEvent, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href, pageOrder);
  }

  return (
    <nav
      // Sticks directly below Masthead, which is also sticky (5.4) —
      // `top: var(--masthead-height)` (Masthead's real measured height,
      // single source of truth in globals.css) is what lets the two bands
      // stack flush with no gap or overlap. z-10, one below Masthead's
      // z-20, so Masthead's own border/background always wins where the
      // two would otherwise fight for the same pixels. Needs its own
      // explicit opaque background for the same reason Masthead does —
      // page content scrolling underneath would otherwise show through.
      className="sticky z-10 flex flex-wrap justify-center gap-x-6 gap-y-2 border-b px-6 py-3 md:px-10"
      style={{
        top: "var(--masthead-height)",
        borderColor: "var(--color-border)",
        background: "var(--color-background)",
      }}
      aria-label="Topics"
    >
      {activeTopic !== undefined && (
        // Accent color (masthead red) rather than the default ink, per
        // design-system/personalized-news-aggregator/MASTER.md's own
        // "sparing use only — rank badges, active nav" scoping for this
        // token: this is the one nav entry that isn't a topic, so it reads
        // visually distinct from the topic links beside it.
        <Link
          href={frontPageHref}
          onClick={(e) => handleClick(e, frontPageHref)}
          className="text-sm font-semibold uppercase tracking-wide hover:underline"
          style={{ color: "var(--color-accent)" }}
        >
          Front Page
        </Link>
      )}
      {/* Covers a stale-URL edge case: activeTopic came from the route, not
          from `topics` (the user's *current* preferences), so a topic
          removed from preferences after a page was bookmarked/linked
          wouldn't otherwise appear in the topics.map below at all — the nav
          would silently drop any indication of where the user is, unlike
          the old dropdown-menu TopicNavBox this replaced, whose trigger
          button always displayed the selected value regardless of list
          membership. Rendered once here, outside the map, so it still shows
          even when topics.map has nothing matching (no element in `topics`
          can ever equal a value that isn't in `topics`, so the map's own
          `topic === activeTopic` branch is simply never true in that case —
          nothing to guard there). The `topics.includes` guard below instead
          protects the opposite, far more common case: when activeTopic IS a
          current preference, it prevents THIS block from rendering a second,
          duplicate `aria-current` span alongside the one the map already
          renders in its normal in-list position. */}
      {activeTopic !== undefined && !topics.includes(activeTopic) && (
        <span
          aria-current="page"
          className="text-sm font-medium uppercase tracking-wide"
          style={{ color: "var(--color-muted-foreground)" }}
        >
          {activeTopic}
        </span>
      )}
      {topics.map((topic) => {
        if (topic === activeTopic) {
          return (
            <span
              key={topic}
              aria-current="page"
              className="text-sm font-medium uppercase tracking-wide"
              style={{ color: "var(--color-muted-foreground)" }}
            >
              {topic}
            </span>
          );
        }
        if (!digestExistsToday) {
          // Greyed out, not hidden: keeps topics visible/discoverable and
          // avoids a dead-end on a stale /topic/x link with no digest yet
          // — "Front Page" above stays a normal link either way.
          return (
            // role="link" so a screen reader announces this as a disabled
            // link (not generic text) even though it's deliberately not in
            // the tab order (nothing to activate) — aria-disabled alone on
            // a bare <span role="generic"> isn't reliably exposed the same
            // way.
            <span
              key={topic}
              role="link"
              aria-disabled="true"
              title="Today's edition hasn't been generated yet"
              className="text-sm font-medium uppercase tracking-wide opacity-40"
              style={{ color: "var(--color-muted-foreground)" }}
            >
              {topic}
            </span>
          );
        }
        return (
          <Link
            key={topic}
            href={`${basePath}/topic/${topicToSlug(topic)}`}
            onClick={(e) => handleClick(e, `${basePath}/topic/${topicToSlug(topic)}`)}
            className="text-sm font-medium uppercase tracking-wide hover:underline"
          >
            {topic}
          </Link>
        );
      })}
    </nav>
  );
}
