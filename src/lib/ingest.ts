import Parser from "rss-parser";
import { FEEDS } from "@/config/feeds";
import { COUNTRIES_TOPIC, COUNTRY_FEEDS } from "@/config/countries";
import { isImplausiblyFuture } from "@/lib/cursor";
import { bestEffortLog } from "@/lib/bestEffortLog";
import { TOPICS, type Article, type Source, type Topic } from "@/types";
import { MAX_READING_UNITS, readingUnits, type ReadingUnit } from "@/lib/readingUnits";

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

async function fetchFeed({ topic, subtopic, source, url }: PlannedFeed): Promise<Article[]> {
  const feed = await parser.parseURL(url);
  return (feed.items ?? []).map((item) => ({
    // Some feeds (e.g. Transfermarkt) pretty-print their XML with a
    // newline inside <title>/<link> itself — rss-parser doesn't trim that,
    // so it'd otherwise leak into card titles and hrefs verbatim.
    title: (item.title ?? "").trim(),
    snippet: stripHtml(item.contentSnippet ?? item.content ?? ""),
    url: (item.link ?? "").trim(),
    source,
    topic,
    // Only a country's articles carry a subtopic; every other article has
    // none at all.
    ...(subtopic ? { subtopic } : {}),
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
 * The most feeds one digest reads for one topic.
 *
 * The catalog keeps every verified feed for a topic; a digest reads at most
 * this many of them. Each picked country is a topic here too, with its own
 * slots. Together with the 10-unit bound (MAX_READING_UNITS, which
 * MAX_TOPICS_PER_DIGEST equals) it bounds a run at 60 feeds, the worst case
 * the spend reservation and the 120 s function limit were measured against.
 * Raising either is a cost decision, not a tweak.
 */
export const MAX_FEEDS_PER_TOPIC = 6;

/**
 * The most topics one digest reads. A saved profile can hold more; the rest
 * are skipped (see topicsToRead) rather than read past the bound.
 */
export const MAX_TOPICS_PER_DIGEST = 10;

/**
 * Splits a profile's topics into the ones this digest reads and the ones it
 * skips: the first MAX_TOPICS_PER_DIGEST in curated (TOPICS) order.
 *
 * Sorted here rather than trusting the caller's order, so the bound picks the
 * same topics however the list arrives. A name no longer in TOPICS (a renamed
 * topic still saved on an old profile) sorts after every known one, so it can
 * never take a slot from a topic that has feeds. Duplicates are read once.
 */
export function topicsToRead(topics: readonly Topic[]): { read: Topic[]; dropped: Topic[] } {
  const position = (t: Topic) => {
    const i = (TOPICS as readonly string[]).indexOf(t);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ordered = [...new Set(topics)].sort((a, b) => position(a) - position(b));
  return {
    read: ordered.slice(0, MAX_TOPICS_PER_DIGEST),
    dropped: ordered.slice(MAX_TOPICS_PER_DIGEST),
  };
}

export interface PlannedFeed {
  topic: Topic;
  /** The country a Countries unit reads; absent for every other topic. */
  subtopic?: string;
  source: Source;
  url: string;
}

/**
 * Which feeds this digest reads, in fetch order: for each reading unit, up to
 * MAX_FEEDS_PER_TOPIC "slots". A topic reads its FEEDS list and a country
 * within Countries reads its COUNTRY_FEEDS list; both list their strongest
 * feeds first. The reader's preferred outlets take a unit's slots first, the
 * rest fill from that order, and both groups keep it.
 *
 * With no preferred outlets a unit simply gets its first slots' worth of
 * feeds. A preferred outlet with no feed for a unit doesn't apply to it.
 *
 * Units are read in the order given, which readingUnits has already made the
 * curated one and capped at MAX_READING_UNITS. The same cap is applied again
 * here, after dropping a repeated unit, so no caller can plan past 60 feeds.
 */
export function planUnitFeeds(
  units: readonly ReadingUnit[],
  preferredSources: readonly Source[] = []
): PlannedFeed[] {
  const preferred = new Set(preferredSources);
  const seen = new Set<string>();
  const distinct = units.filter((unit) => {
    // Only a country's subtopic picks different feeds, so it is the only one
    // that makes a unit distinct. JSON-encoded so no topic or country name
    // can forge another unit's key.
    const key = JSON.stringify([unit.topic, unit.topic === COUNTRIES_TOPIC ? (unit.subtopic ?? null) : null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const plan: PlannedFeed[] = [];
  // Some outlets file one feed under both a topic and a country (French
  // Politics and France share two). An earlier unit already reads it, so a
  // later unit gives the slot to its next feed instead. Compared by feedKey,
  // because the two lists can spell one feed differently.
  const planned = new Set<string>();
  for (const { topic, subtopic } of distinct.slice(0, MAX_READING_UNITS)) {
    const country = topic === COUNTRIES_TOPIC && subtopic ? subtopic : null;
    // Own-property lookup: a country is a name from a reader's saved picks,
    // and "constructor" must find no feeds rather than Object's prototype.
    const grid = country
      ? Object.hasOwn(COUNTRY_FEEDS, country)
        ? COUNTRY_FEEDS[country]
        : {}
      : (FEEDS[topic] ?? {});
    const feeds = (Object.entries(grid) as [Source, string][]).filter(([, url]) => !planned.has(feedKey(url)));
    const slots = [
      ...feeds.filter(([source]) => preferred.has(source)),
      ...feeds.filter(([source]) => !preferred.has(source)),
    ].slice(0, MAX_FEEDS_PER_TOPIC);
    for (const [source, url] of slots) {
      planned.add(feedKey(url));
      plan.push(country ? { topic, subtopic: country, source, url } : { topic, source, url });
    }
  }
  return plan;
}

/**
 * One feed's identity across the catalog: the same normalisation as an
 * article URL, so a trailing slash, http vs https or a www prefix (Challenge.ma
 * is `/feed` in FEEDS and `/feed/` in COUNTRY_FEEDS) is not a second feed.
 */
function feedKey(url: string): string {
  return normalizeArticleUrl(url) ?? url;
}

/**
 * planUnitFeeds for a list of topics with no countries picked. Countries
 * itself reads nothing here, since the container is never a unit.
 */
export function planFeeds(
  topics: readonly Topic[],
  preferredSources: readonly Source[] = []
): PlannedFeed[] {
  return planUnitFeeds(readingUnits(topics, []).read, preferredSources);
}

/**
 * Query parameters that only say how a reader arrived, never which article
 * it is. Matched case-insensitively; anything starting `utm_` counts too.
 */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "ocid",
  "mc_cid",
  "mc_eid",
  "smid",
  "cmpid",
  "igshid",
  "at_medium",
  "at_campaign",
]);

function isNoiseParam(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) return true;
  // The AMP rendering of the same page, selected by query rather than path.
  return lower === "amp" || (lower === "outputtype" && value.toLowerCase() === "amp");
}

/**
 * A comparison key for an article URL: the same article reached through
 * tracking tags, an AMP or mobile host or path, a trailing slash, a fragment,
 * http vs https, or reordered query parameters maps to one key.
 *
 * Only a key — the article keeps the URL its feed gave, which is the one
 * shown to the reader. A string that isn't an http(s) URL keys on itself
 * (trimmed), which is exact matching; an empty one has no key, because two
 * articles both missing a link are not the same article.
 */
export function normalizeArticleUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;

  // URL has already lower-cased the scheme and host and dropped a default port.
  const host = url.hostname.replace(/^(?:www|amp|m)\./, "");
  const pathWithoutSlash = url.pathname.replace(/\/+$/, "");
  // An /amp prefix or suffix marks the AMP copy of another page, never the
  // site's home page, so it is only stripped when something is left.
  const withoutAmp = pathWithoutSlash
    .replace(/^\/amp(?=\/)/, "")
    .replace(/\/amp$/, "")
    .replace(/\/+$/, "");
  const path = withoutAmp || pathWithoutSlash || "/";
  const params = [...url.searchParams.entries()]
    .filter(([name, value]) => !isNoiseParam(name, value))
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  // A fragment is normally a position on the page and is dropped, except a
  // hash route ("#/article/1", "#!article-1"), where it names the article.
  // The route gets the same slash treatment as the path; an empty one is no
  // route at all.
  const route = url.hash.startsWith("#!") ? url.hash.slice(2) : url.hash.startsWith("#/") ? url.hash.slice(1) : "";
  const routeKey = route.replace(/^\/+/, "").replace(/\/+$/, "");
  const fragment = routeKey === "" ? "" : `#/${routeKey}`;

  return `${host}${url.port ? `:${url.port}` : ""}${path}${query}${fragment}`;
}

/**
 * A comparison key for a headline: case, Unicode compatibility forms,
 * punctuation and spacing don't distinguish two headlines. Null for a
 * headline with no letters or digits, so untitled items never collapse into
 * each other.
 */
export function normalizeTitle(title: string): string | null {
  const key = title
    .normalize("NFKC")
    .toLowerCase()
    // Enclosing marks (a keycap) and variation selectors (emoji vs text
    // presentation) only restyle the symbol before them. Combining marks
    // are otherwise kept: in an abugida a vowel sign is part of the word.
    .replace(/[\p{Me}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(key) ? key : null;
}

/**
 * Drops repeat sightings of one article, keeping the first.
 *
 * Two articles are the same when their URLs normalise to the same key, or
 * when one outlet published both under the same normalised headline (the
 * same piece syndicated into two of its feeds, or re-issued under a new
 * link). The title check is same-outlet only: two outlets running an
 * identical wire headline are two sources, which is what clustering and the
 * card's source count should see.
 */
export function dedupeArticles(articles: readonly Article[]): Article[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  return articles.filter((a) => {
    const urlKey = normalizeArticleUrl(a.url);
    const titleBody = normalizeTitle(a.title);
    // JSON-encoded so no outlet name or headline can forge another pair's key.
    const titleKey = titleBody === null ? null : JSON.stringify([a.source, titleBody]);
    if ((urlKey !== null && seenUrls.has(urlKey)) || (titleKey !== null && seenTitles.has(titleKey))) {
      return false;
    }
    if (urlKey !== null) seenUrls.add(urlKey);
    if (titleKey !== null) seenTitles.add(titleKey);
    return true;
  });
}

/**
 * Pulls the RSS feeds planUnitFeeds picks for the given reading units, in
 * parallel. A single feed failing (e.g. an outlet is briefly down) doesn't
 * take down the whole digest — it's logged and skipped.
 *
 * Every article a country unit reads is tagged with `topic: "Countries"` and
 * its country as `subtopic`; every other article has no subtopic.
 *
 * Preferred sources decide which feeds fill a unit's slots, never which
 * articles survive: with none picked, every unit still reads its feeds.
 *
 * Only articles published after `sinceIso` are kept, so a slow-moving feed
 * can't hand back stale multi-day-old items in a "daily" digest, and so a
 * story already covered in an earlier run isn't ingested a second time.
 * Pass `null` when the user has never generated (see LOOKBACK_CEILING_MS
 * above, which also caps how far back a stale cursor can reach).
 */
export async function ingestUnits(
  units: readonly ReadingUnit[],
  preferredSources: readonly Source[],
  sinceIso: string | null
): Promise<Article[]> {
  const jobs = planUnitFeeds(units, preferredSources).map((feed) =>
    fetchFeed(feed).catch((err) => {
      const where = feed.subtopic ? `${feed.topic}/${feed.subtopic}` : feed.topic;
      bestEffortLog("error", `[ingest] failed ${feed.source}/${where}:`, err instanceof Error ? err.message : err);
      return [];
    })
  );

  const results = await Promise.all(jobs);

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
  //    (ingestUnits is exported and callable with any cursor, and the
  //    clock can move between the query and this line), so it should
  //    essentially never fire in production; the warning is what makes it
  //    say so out loud rather than degrading quietly.
  const parsedSince = sinceIso ? new Date(sinceIso) : null;
  const now = Date.now();
  const ceiling = new Date(now - LOOKBACK_CEILING_MS);

  let cutoff = ceiling;
  if (parsedSince && !Number.isNaN(parsedSince.getTime())) {
    if (isImplausiblyFuture(parsedSince, now)) {
      // Best-effort: a diagnostic on a critical path must not be able to fail
      // the thing it is reporting on. A throwing logger here would turn a
      // deliberate graceful fallback into a failed digest run.
      bestEffortLog(
        "warn",
        `[ingest] since-cursor ${parsedSince.toISOString()} is implausibly far ahead of this machine's clock — treating as corrupt and falling back to the ${LOOKBACK_CEILING_MS / (60 * 60 * 1000)}h window`
      );
    } else if (parsedSince > ceiling) {
      cutoff = parsedSince;
    }
  }

  // The cutoff runs before duplicate removal, not after: the title check
  // matches different links from one outlet, so a stale item seen first
  // would otherwise knock out a fresh one and then be cut itself, leaving
  // neither.
  //
  // The same article can arrive more than once — a BBC piece syndicated into
  // both its Technology and World feeds, or one link carrying tracking tags
  // in one feed and not another. Counted twice, it would make a one-source
  // story look corroborated. The first sighting wins, and feeds are in unit
  // order, so an article a country shares with Africa keeps the country:
  // Countries comes before the regional topics.
  return dedupeArticles(results.flat().filter((a) => new Date(a.publishedAt) >= cutoff));
}

/**
 * ingestUnits for a list of topics with no countries picked: the digest route
 * calls this until it reads a profile's countries itself.
 */
export async function ingestArticles(
  topics: readonly Topic[],
  preferredSources: readonly Source[],
  sinceIso: string | null
): Promise<Article[]> {
  return ingestUnits(readingUnits(topics, []).read, preferredSources, sinceIso);
}
