import type { Article } from "@/types";

/** How many gathered titles the `clustering` event carries for the loaders. */
export const WIRE_TITLE_LIMIT = 20;
/** Longer titles are cut at a word boundary and end in an ellipsis. */
export const WIRE_TITLE_MAX_CHARS = 140;

// Only this much of a raw title is ever looked at: a feed item's fields have
// no length bound (one snippet has arrived at 48,191 characters), and nothing
// past the cap below can reach the reader anyway.
const RAW_TITLE_SCAN_CHARS = 1_000;

/**
 * Collapses every run of whitespace and control characters (a feed's title
 * can carry a raw NUL) to one space, trims, and caps the length.
 */
export function cleanWireTitle(raw: string): string {
  const collapsed = raw.slice(0, RAW_TITLE_SCAN_CHARS).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  if (collapsed.length <= WIRE_TITLE_MAX_CHARS) return collapsed;
  const room = collapsed.slice(0, WIRE_TITLE_MAX_CHARS - 1);
  const lastSpace = room.lastIndexOf(" ");
  // A title with no space in its first stretch is cut mid-word rather than
  // shrunk to nothing.
  const cut = lastSpace > WIRE_TITLE_MAX_CHARS / 2 ? room.slice(0, lastSpace) : room;
  return `${cut.trimEnd()}…`;
}

/**
 * A sample of the titles a run just gathered, for the loading animations to
 * show while the run works: up to `limit`, spread across the reader's reading
 * units and, within each unit, across outlets, so one busy feed can't fill
 * the whole sample.
 *
 * Takes one title per unit per round, each unit cycling through its own
 * outlets, in the order the articles arrived. Duplicates (the same wire
 * headline from two outlets) are dropped case-insensitively.
 *
 * The titles are untrusted fetched text: callers render them as plain text
 * only, never as HTML.
 */
export function sampleWireTitles(articles: readonly Article[], limit = WIRE_TITLE_LIMIT): string[] {
  // unit key -> outlet -> that outlet's titles, all in arrival order.
  const units = new Map<string, Map<string, string[]>>();
  for (const article of articles) {
    const unitKey = `${article.topic}\u0000${article.subtopic ?? ""}`;
    let outlets = units.get(unitKey);
    if (!outlets) {
      outlets = new Map();
      units.set(unitKey, outlets);
    }
    const titles = outlets.get(article.source) ?? [];
    titles.push(article.title);
    outlets.set(article.source, titles);
  }

  // Each unit's titles, interleaved across its outlets.
  const unitQueues = [...units.values()].map((outlets) => {
    const lists = [...outlets.values()];
    const queue: string[] = [];
    const longest = Math.max(...lists.map((l) => l.length));
    for (let i = 0; i < longest; i++) {
      for (const list of lists) if (i < list.length) queue.push(list[i]);
    }
    return queue;
  });

  const picked: string[] = [];
  const seen = new Set<string>();
  const cursors = unitQueues.map(() => 0);
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (let u = 0; u < unitQueues.length && picked.length < limit; u++) {
      const queue = unitQueues[u];
      // Advance this unit to its next usable title, so a unit whose next
      // entry is a duplicate or blank still contributes one this round.
      while (cursors[u] < queue.length) {
        const title = cleanWireTitle(queue[cursors[u]++]);
        const key = title.toLowerCase();
        if (title === "" || seen.has(key)) continue;
        seen.add(key);
        picked.push(title);
        progressed = true;
        break;
      }
    }
  }
  return picked;
}
