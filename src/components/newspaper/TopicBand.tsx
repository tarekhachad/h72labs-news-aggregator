"use client";

import Link from "next/link";
import type { Topic } from "@/types";
import { topicToSlug } from "@/lib/topicSlug";
import { buildPageOrder } from "@/lib/pageOrder";
import { usePageTransitionActions } from "@/components/newspaper/PageTransitionContext";

/**
 * Front-page-only horizontal band of topic links, below the masthead — the
 * primary way to navigate to a topic page from the front page (see
 * docs/(C) UI_DESIGN.md's Front page section). Selecting a topic triggers
 * the page-flip transition (B8).
 */
export function TopicBand({
  topics,
  basePath = "",
}: {
  topics: Topic[];
  /** "/history/2026-08-01" when this band is on a past date's front page, so its links stay scoped to that date instead of jumping to today. */
  basePath?: string;
}) {
  const { navigate } = usePageTransitionActions();

  if (topics.length === 0) return null;

  const pageOrder = buildPageOrder(topics, basePath);

  function handleClick(e: React.MouseEvent, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href, pageOrder);
  }

  return (
    <nav
      className="flex flex-wrap gap-x-6 gap-y-2 border-b px-6 py-3 md:px-10"
      style={{ borderColor: "var(--color-border)" }}
      aria-label="Topics"
    >
      {topics.map((topic) => {
        const href = `${basePath}/topic/${topicToSlug(topic)}`;
        return (
          <Link
            key={topic}
            href={href}
            onClick={(e) => handleClick(e, href)}
            className="text-sm font-medium uppercase tracking-wide hover:underline"
          >
            {topic}
          </Link>
        );
      })}
    </nav>
  );
}
