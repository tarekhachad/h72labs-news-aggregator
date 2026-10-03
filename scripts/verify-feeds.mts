/**
 * Fetches every RSS feed in `src/config/feeds.ts` and reports, per feed,
 * whether it meets the bar a feed has to clear to ship: it parses as RSS or
 * Atom, it has items, its newest item is recent, every item has a title and
 * a link, its items carry real text, and the robots.txt of every host the
 * feed's fetch passes through (redirects included) allows it.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-feeds.mts
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-feeds.mts --file candidates.json
 *
 * `--file` checks a JSON array of `{ topic, source, url }` instead of FEEDS,
 * which is how a candidate feed is checked before it is added. Exits 1 if any
 * feed fails, so it can gate a change.
 *
 * Parses with the same library, User-Agent and timeout as `src/lib/ingest.ts`,
 * so a pass here means the digest's own fetch would see the same feed. It runs
 * from wherever it is started, though, and news sites block datacenter
 * addresses more often than home ones, so a laptop pass does not promise a
 * Vercel pass.
 *
 * `.mts` for the same reason as `scripts/cost-report.mts`: it marks the file
 * as an ES module without touching package.json.
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Parser from "rss-parser";
import { FEEDS } from "../src/config/feeds.ts";

// Mirrors ingest.ts. If those change, change these with them, or a pass here
// stops meaning anything about what the digest sees.
const USER_AGENT = "Mozilla/5.0 (compatible; H72NewsAggregator/0.1)";
const TIMEOUT_MS = 10_000;

// The bar. A digest reads 48 hours back at most, so a feed whose newest item
// is older than four days gives a digest nothing on most days. The snippet
// floor is low on purpose: it is there to catch feeds that send a headline and
// nothing else, not to rank feeds that send short summaries.
const MAX_NEWEST_AGE_HOURS = 96;
const MIN_MEDIAN_SNIPPET_CHARS = 40;

const CONCURRENCY = 12;

interface FeedToCheck {
  topic: string;
  source: string;
  url: string;
}

interface FeedResult extends FeedToCheck {
  pass: boolean;
  items: number;
  newestAgeHours: number | null;
  medianSnippet: number;
  robots: "allowed" | "disallowed" | "unreachable";
  /** The feed's own title, for checking a feed is about the topic it is filed under. */
  feedTitle: string;
  reason: string;
}

const parser = new Parser({ timeout: TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } });

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// --- robots.txt -------------------------------------------------------------
//
// A small reading of the robots rules that apply to us: the group naming our
// User-Agent token if there is one, otherwise the `*` group. Within it the
// longest matching rule wins and Allow wins a tie, with `*` and `$` patterns
// (RFC 9309). One fetch per host, shared by every feed on it.
//
// RFC 9309 splits a missing robots.txt from an unreachable one: a 4xx means
// there are no rules, while a 5xx or a failed connection means the crawler
// must assume everything is disallowed.

type RobotsFile = { kind: "rules"; text: string } | { kind: "none" } | { kind: "unreachable" };

export const robotsCache = new Map<string, Promise<RobotsFile>>();

function fetchRobots(origin: string): Promise<RobotsFile> {
  let pending = robotsCache.get(origin);
  if (!pending) {
    pending = fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then(async (res): Promise<RobotsFile> => {
        if (res.ok) return { kind: "rules", text: await res.text() };
        await res.body?.cancel();
        return res.status >= 500 ? { kind: "unreachable" } : { kind: "none" };
      })
      .catch((): RobotsFile => ({ kind: "unreachable" }));
    robotsCache.set(origin, pending);
  }
  return pending;
}

// Every URL the feed's fetch passes through. rss-parser follows redirects on
// its own, and the robots rules of each host along the way apply, not just the
// first one's.
const MAX_REDIRECTS = 5;

// `complete` is false when a hop could not be fetched or its Location could
// not be read: the rest of the path is unknown, so its robots rules are too.
export async function redirectChain(url: string): Promise<{ urls: string[]; complete: boolean }> {
  const urls = [url];
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        // rss-parser's own headers, so a server that redirects by header sends
        // this walk where it sends the real fetch.
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { urls, complete: false };
    }
    await res.body?.cancel();
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) break;
    try {
      current = new URL(location, current).href;
    } catch {
      return { urls, complete: false };
    }
    urls.push(current);
  }
  return { urls, complete: true };
}

export async function robotsVerdict({
  urls,
  complete,
}: {
  urls: string[];
  complete: boolean;
}): Promise<FeedResult["robots"]> {
  let verdict: FeedResult["robots"] = complete ? "allowed" : "unreachable";
  for (const href of urls) {
    const url = new URL(href);
    const file = await fetchRobots(url.origin);
    if (file.kind === "unreachable") {
      verdict = "unreachable";
    } else if (file.kind === "rules" && !robotsAllows(file.text, "H72NewsAggregator", url.pathname + url.search)) {
      return "disallowed";
    }
  }
  return verdict;
}

function rulesFor(robotsTxt: string, agentToken: string): { allow: boolean; path: string }[] {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of robotsTxt.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      // An empty Disallow means "nothing is disallowed", so it adds no rule.
      if (value) current.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const token = agentToken.toLowerCase();
  // RFC 9309 matches the crawler's product token itself, case-insensitively;
  // a line may carry a version ("Bot/1.0"), which is not part of the token.
  const named = groups.filter((g) => g.agents.some((a) => a.split("/")[0].trim() === token));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function ruleMatches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

export function robotsAllows(robotsTxt: string, agentToken: string, path: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rulesFor(robotsTxt, agentToken)) {
    if (!ruleMatches(rule.path, path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

// --- one feed ---------------------------------------------------------------

export async function checkFeed(feed: FeedToCheck): Promise<FeedResult> {
  const result: FeedResult = {
    ...feed,
    pass: false,
    items: 0,
    newestAgeHours: null,
    medianSnippet: 0,
    robots: "allowed",
    feedTitle: "",
    reason: "",
  };

  try {
    new URL(feed.url);
  } catch {
    result.reason = "not a valid URL";
    return result;
  }
  result.robots = await robotsVerdict(await redirectChain(feed.url));

  let parsed: Awaited<ReturnType<typeof parser.parseURL>>;
  try {
    parsed = await parser.parseURL(feed.url);
  } catch (err) {
    result.reason = `fetch/parse: ${(err as Error).message.split("\n")[0].slice(0, 80)}`;
    return result;
  }

  const items = parsed.items ?? [];
  result.items = items.length;
  result.feedTitle = (parsed.title ?? "").trim();

  const times = items
    .map((item) => new Date(item.isoDate ?? item.pubDate ?? "").getTime())
    .filter((t) => !Number.isNaN(t) && t <= Date.now() + 60 * 60 * 1000);
  if (times.length > 0) {
    result.newestAgeHours = Math.round(((Date.now() - Math.max(...times)) / 3_600_000) * 10) / 10;
  }

  result.medianSnippet = median(
    items.map((item) => stripHtml(item.contentSnippet ?? item.content ?? "").length)
  );
  const untitled = items.filter((item) => !(item.title ?? "").trim()).length;
  // Ingest removes duplicate articles by URL, so items without a link would
  // collapse into one.
  const unlinked = items.filter((item) => !(item.link ?? "").trim()).length;

  const problems: string[] = [];
  if (result.robots === "disallowed") problems.push("robots.txt disallows this path");
  if (result.robots === "unreachable") {
    problems.push("robots.txt unreachable (5xx, no answer, or a redirect that could not be followed)");
  }
  if (items.length === 0) problems.push("no items");
  if (result.newestAgeHours === null && items.length > 0) problems.push("no item dates");
  if (result.newestAgeHours !== null && result.newestAgeHours > MAX_NEWEST_AGE_HOURS) {
    problems.push(`newest item ${Math.round(result.newestAgeHours / 24)}d old`);
  }
  if (items.length > 0 && result.medianSnippet < MIN_MEDIAN_SNIPPET_CHARS) {
    problems.push(`median snippet ${result.medianSnippet} chars`);
  }
  if (untitled > 0) problems.push(`${untitled} untitled items`);
  if (unlinked > 0) problems.push(`${unlinked} items without a link`);

  result.pass = problems.length === 0;
  result.reason = problems.join("; ");
  return result;
}

export async function runAll(feeds: FeedToCheck[]): Promise<FeedResult[]> {
  const results: FeedResult[] = new Array(feeds.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < feeds.length) {
      const index = next++;
      results[index] = await checkFeed(feeds[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, feeds.length) }, worker));
  return results;
}

// --- main -------------------------------------------------------------------

async function loadFeeds(): Promise<FeedToCheck[]> {
  const fileFlag = process.argv.indexOf("--file");
  if (fileFlag !== -1) {
    const path = process.argv[fileFlag + 1];
    if (!path) throw new Error("--file needs a path");
    return JSON.parse(await readFile(path, "utf8")) as FeedToCheck[];
  }
  return Object.entries(FEEDS).flatMap(([topic, bySource]) =>
    Object.entries(bySource).map(([source, url]) => ({ topic, source, url: url as string }))
  );
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  const feeds = await loadFeeds();
  const results = await runAll(feeds);

  const asJson = process.argv.includes("--json");
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(
      `${pad("", 4)} ${pad("topic", 26)} ${pad("source", 24)} ${pad("items", 5)} ${pad("newest", 7)} ${pad("snippet", 7)} reason`
    );
    for (const r of results) {
      const age = r.newestAgeHours === null ? "-" : `${r.newestAgeHours}h`;
      console.log(
        `${pad(r.pass ? "PASS" : "FAIL", 4)} ${pad(r.topic, 26)} ${pad(r.source, 24)} ${pad(String(r.items), 5)} ${pad(age, 7)} ${pad(String(r.medianSnippet), 7)} ${r.reason}`
      );
    }
  }

  const failed = results.filter((r) => !r.pass);
  const summary = `${results.length - failed.length}/${results.length} feeds pass`;
  if (asJson) console.error(summary);
  else console.log(`\n${summary}`);
  // Exits explicitly: rss-parser's timeout rejects the promise but leaves the
  // request open, and a server that never finishes its response would keep
  // the process alive long after the report is printed.
  process.exit(failed.length > 0 ? 1 : 0);
}

// Runs only when executed directly, so the checks above can be imported and
// tested without printing a report or exiting. Node resolves symlinks in this
// module's own URL but not in argv, so the path is resolved before comparing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
