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

async function fetchFeed(
  topic: Topic,
  source: Source,
  feedUrl: string
): Promise<Article[]> {
  const feed = await parser.parseURL(feedUrl);
  return (feed.items ?? []).map((item) => ({
    title: item.title ?? "",
    snippet: stripHtml(item.contentSnippet ?? item.content ?? ""),
    url: item.link ?? "",
    source,
    topic,
    publishedAt: item.isoDate ?? item.pubDate ?? new Date().toISOString(),
  }));
}

/**
 * Pulls every RSS feed configured for the given topics, in parallel.
 * A single feed failing (e.g. an outlet is briefly down) doesn't take
 * down the whole digest — it's logged and skipped.
 */
export async function ingestArticles(topics: Topic[]): Promise<Article[]> {
  const jobs: Promise<Article[]>[] = [];

  for (const topic of topics) {
    const sourcesForTopic = FEEDS[topic] ?? {};
    for (const [source, feedUrl] of Object.entries(sourcesForTopic) as [
      Source,
      string
    ][]) {
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
  return articles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}
