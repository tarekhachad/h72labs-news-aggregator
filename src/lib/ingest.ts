import Parser from "rss-parser";
import { FEEDS } from "@/config/feeds";
import { isImplausiblyFuture } from "@/lib/cursor";
import type { Article, Source, Topic } from "@/types";

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; H72NewsAggregator/0.1)" },
});

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

// A malformed/unparseable RSS date (item.isoDate/pubDate present but not a
// real date) would otherwise become an Invalid Date that silently fails
// every downstream comparison (recency filtering, card date sorting) —
// normalize to "now" instead, same as when the feed omits a date entirely.
function normalizePublishedAt(raw: string | undefined): string {
  if (raw && !Number.isNaN(new Date(raw).getTime())) return raw;
  return new Date().toISOString();
}

async function fetchFeed(
  topic: Topic,
  source: Source,
  feedUrl: string
): Promise<Article[]> {
  const feed = await parser.parseURL(feedUrl);
  return (feed.items ?? []).map((item) => ({
    // Some feeds (e.g. Transfermarkt) pretty-print their XML with a
    // newline inside <title>/<link> itself — rss-parser doesn't trim that,
    // so it'd otherwise leak into card titles and hrefs verbatim.
    title: (item.title ?? "").trim(),
    snippet: stripHtml(item.contentSnippet ?? item.content ?? ""),
    url: (item.link ?? "").trim(),
    source,
    topic,
    publishedAt: normalizePublishedAt(item.isoDate ?? item.pubDate),
  }));
}

// A ceiling on how far back any single run reaches, not just a first-run
// fallback: the cutoff is the *later* of the caller's since-cursor and
// now − 48h. A brand-new user (no cursor yet) gets the full 48h rather than
// a feed's entire history; someone returning after a week gets 48h too,
// rather than seven days of backlog in one digest.
const LOOKBACK_CEILING_MS = 48 * 60 * 60 * 1000;

/**
 * Pulls the RSS feeds configured for the given topics and preferred
 * sources, in parallel. A single feed failing (e.g. an outlet is briefly
 * down) doesn't take down the whole digest — it's logged and skipped.
 *
 * Only articles published after `sinceIso` are kept, so a slow-moving feed
 * can't hand back stale multi-day-old items in a "daily" digest, and so a
 * story already covered in an earlier run isn't ingested a second time.
 * Pass `null` when the user has never generated (see LOOKBACK_CEILING_MS
 * above, which also caps how far back a stale cursor can reach).
 */
export async function ingestArticles(
  topics: Topic[],
  preferredSources: Source[],
  sinceIso: string | null
): Promise<Article[]> {
  const preferred = new Set(preferredSources);
  const jobs: Promise<Article[]>[] = [];

  for (const topic of topics) {
    const sourcesForTopic = FEEDS[topic] ?? {};
    for (const [source, feedUrl] of Object.entries(sourcesForTopic) as [
      Source,
      string
    ][]) {
      if (!preferred.has(source)) continue;
      jobs.push(
        fetchFeed(topic, source, feedUrl).catch((err) => {
          console.error(`[ingest] failed ${source}/${topic}:`, err.message);
          return [];
        })
      );
    }
  }

  const results = await Promise.all(jobs);
  const articles = results.flat();

  // The same real-world story can appear in more than one feed we pull —
  // e.g. a BBC article syndicated into both its Technology and World
  // feeds when the profile includes both topics. Keep the first sighting
  // only, so it doesn't end up double-counted in the same cluster.
  const seen = new Set<string>();
  const deduped = articles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  // A malformed sinceIso (e.g. a corrupted stored timestamp) must not
  // silently turn into a cutoff of "everything fails the >= check" — it's
  // treated as no cursor at all, leaving the ceiling as the cutoff.
  //
  // A cursor ahead of this machine's clock is split in two, because the two
  // ends of that range fail in opposite directions:
  //
  //  - Ordinary skew (within tolerance) is honoured as-is. It yields a run
  //    that finds nothing, which is the truthful answer to "what's new since
  //    a moment ago." Falling back to the ceiling here would be actively
  //    harmful: if the process stamping the cursor runs a few seconds fast,
  //    EVERY subsequent run would see a future cursor, fall back, and
  //    re-ingest a full 48h — a permanent duplicate storm at roughly 10× the
  //    per-digest cost, not a one-off.
  //
  //  - A cursor implausibly far ahead is corrupt, and using it would empty
  //    the digest silently. Falling back to the ceiling is the better of two
  //    bad outcomes, but it is genuinely a *bad* one and not self-correcting:
  //    if a stored row really does hold a garbage timestamp, this branch
  //    fires on every run until wall-clock time overtakes it or someone
  //    fixes the row. That's why the primary defence is one layer up, in
  //    getLatestGeneratedAtForUser, which excludes such rows from the query
  //    so a legitimate older cursor can win instead — see the note there.
  //    This branch is the backstop for a value that reaches here anyway
  //    (ingestArticles is exported and callable with any cursor, and the
  //    clock can move between the query and this line), so it should
  //    essentially never fire in production; the warning is what makes it
  //    say so out loud rather than degrading quietly.
  const parsedSince = sinceIso ? new Date(sinceIso) : null;
  const now = Date.now();
  const ceiling = new Date(now - LOOKBACK_CEILING_MS);

  let cutoff = ceiling;
  if (parsedSince && !Number.isNaN(parsedSince.getTime())) {
    if (isImplausiblyFuture(parsedSince, now)) {
      // Guarded for the same reason usageCollector.ts guards its own logging:
      // a diagnostic on a critical path must not be able to fail the thing it
      // is reporting on. Unguarded, a throwing logger here would turn a
      // deliberate graceful fallback into a failed digest run — the exact
      // shape of the F.2 bug where an unguarded console.log dropped a card
      // and turned a successful expand into a 502.
      try {
        console.warn(
          `[ingest] since-cursor ${parsedSince.toISOString()} is implausibly far ahead of this machine's clock — treating as corrupt and falling back to the ${LOOKBACK_CEILING_MS / (60 * 60 * 1000)}h window`
        );
      } catch {
        // Losing the line is strictly better than losing the digest.
      }
    } else if (parsedSince > ceiling) {
      cutoff = parsedSince;
    }
  }

  return deduped.filter((a) => new Date(a.publishedAt) >= cutoff);
}
