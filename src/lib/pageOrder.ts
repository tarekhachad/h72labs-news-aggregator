import type { Topic } from "@/types";
import { topicToSlug } from "@/lib/topicSlug";

/**
 * The canonical page sequence for the page-flip transition (B8) — front
 * page first, then the user's own topics in their TopicBand/dropdown
 * display order. Not the full TOPICS list: only pages actually reachable
 * via the newspaper UI belong in the sequence a "jump through intervening
 * pages" count is measured against.
 */
export function buildPageOrder(userTopics: Topic[], basePath = ""): string[] {
  return [basePath || "/", ...userTopics.map((t) => `${basePath}/topic/${topicToSlug(t)}`)];
}

/**
 * How many pages a navigation from `fromHref` to `toHref` skips over, per
 * `pageOrder` — 0 for an adjacent page (or the same page), 1 for one
 * intervening page, etc. Returns null if either href isn't part of the
 * sequence (e.g. a Sidebar destination like /saved) — the caller should
 * treat that as "not a flip-eligible navigation," not force a flip count.
 */
export function pagesBetween(fromHref: string, toHref: string, pageOrder: string[]): number | null {
  const fromIndex = pageOrder.indexOf(fromHref);
  const toIndex = pageOrder.indexOf(toHref);
  if (fromIndex === -1 || toIndex === -1) return null;
  return Math.abs(toIndex - fromIndex);
}
