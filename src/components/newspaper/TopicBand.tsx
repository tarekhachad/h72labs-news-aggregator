import Link from "next/link";
import type { Topic } from "@/types";
import { topicToSlug } from "@/lib/topicSlug";

/**
 * Front-page-only horizontal band of topic links, below the masthead — the
 * primary way to navigate to a topic page from the front page (see
 * docs/(C) UI_DESIGN.md's Front page section).
 */
export function TopicBand({
  topics,
  basePath = "",
}: {
  topics: Topic[];
  /** "/history/2026-08-01" when this band is on a past date's front page, so its links stay scoped to that date instead of jumping to today. */
  basePath?: string;
}) {
  if (topics.length === 0) return null;

  return (
    <nav
      className="flex flex-wrap gap-x-6 gap-y-2 border-b px-6 py-3 md:px-10"
      style={{ borderColor: "var(--color-border)" }}
      aria-label="Topics"
    >
      {topics.map((topic) => (
        <Link
          key={topic}
          href={`${basePath}/topic/${topicToSlug(topic)}`}
          className="text-sm font-medium uppercase tracking-wide hover:underline"
        >
          {topic}
        </Link>
      ))}
    </nav>
  );
}
