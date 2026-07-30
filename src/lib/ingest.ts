import Parser from "rss-parser";
import { FEEDS } from "@/config/feeds";
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

// When there's no "last digest" timestamp yet (very first run, or the
// browser's localStorage was cleared) there's nothing to filter "since" —
// fall back to a fixed lookback window so the first-ever digest doesn't
// pull a feed's entire history instead of just recent news.
const FIRST_RUN_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * Pulls the RSS feeds configured for the given topics and preferred
 * sources, in parallel. A single feed failing (e.g. an outlet is briefly
 * down) doesn't take down the whole digest — it's logged and skipped.
 *
 * Only articles published after `sinceIso` are kept, so a slow-moving feed
 * can't hand back stale multi-day-old items in a "daily" digest. Pass
 * `null` on the first-ever run (see FIRST_RUN_LOOKBACK_MS fallback above).
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

  // A malformed sinceIso (e.g. a client bug) must not silently turn into a
  // cutoff of "everything fails the >= check" — fall back to the same
  // lookback window used when there's no timestamp at all.
  const parsedSince = sinceIso ? new Date(sinceIso) : null;
  const cutoff =
    parsedSince && !Number.isNaN(parsedSince.getTime())
      ? parsedSince
      : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);

  return deduped.filter((a) => new Date(a.publishedAt) >= cutoff);
}
