/**
 * Full-text extraction: fetch an article's own page and pull out its body
 * text, so the card writer works from the article instead of the feed's
 * one-sentence snippet.
 *
 * Standalone on purpose. No Claude calls and no knowledge of cards: it takes
 * URLs and a deadline and returns, per URL, either text or the reason there
 * is none. The card writer and the full report use it today; the duplicate
 * check can use it for its borderline pairs later.
 *
 * The rules it keeps, because a news site's refusal is final:
 *   - An honest User-Agent, the same one ingest reads feeds with.
 *   - robots.txt is checked before EVERY request, on every redirect hop, not
 *     just the first URL's host. A host whose robots.txt can't be read is
 *     treated as refusing (RFC 9309).
 *   - A 401, 403, 429 or any other non-2xx answer is the result. No retry,
 *     no other User-Agent, no mirror, no proxy.
 *
 * What it returns is material for a prompt only. Callers never store it and
 * never show it: a card keeps its RSS snippet.
 *
 * linkedom rather than jsdom, measured on ten real news pages parsed 300
 * times each way with a GC between parses: linkedom 21 ms a page and a
 * 107 MB peak, jsdom 133 ms and 1,083 MB. Loading it costs about 50 ms
 * against jsdom's 280-400 ms, which every cold start would pay.
 */

import "server-only";
import { lookup } from "node:dns/promises";
import { Worker } from "node:worker_threads";
import { bestEffortLog } from "@/lib/bestEffortLog";
import type { ParserLimits, ParserReply } from "@/lib/extractWorker.mts";

/** The most text handed back per article: the writer's per-article budget. */
export const MAX_TEXT_CHARS = 1500;

// Mirrors ingest.ts, so a site sees one consistent visitor. The token before
// the version is what robots.txt groups are matched against.
const USER_AGENT = "Mozilla/5.0 (compatible; H72NewsAggregator/0.1)";
const ROBOTS_AGENT_TOKEN = "H72NewsAggregator";

/**
 * Pages fetched and parsed at once, across every caller in the process. The
 * digest starts every card at the same moment, so without this an 80-card
 * first run would open a few hundred connections together. Eight keeps the
 * page bodies in memory at once to at most 8 × MAX_HTML_BYTES, and at the
 * measured 50-400 ms a fetch it still clears about a hundred pages in the
 * 15 s the writer allows. Parsing happens one page at a time in the parser
 * thread (below), whatever this number is.
 */
export const MAX_CONCURRENT_PAGES = 8;

/**
 * A page's HTML is read up to this size and refused past it. The pages
 * measured were 68-472 KB; the cap leaves room for heavy pages while keeping
 * eight in flight to about 24 MB of raw bytes.
 */
export const MAX_HTML_BYTES = 3 * 1024 * 1024;

/**
 * Limits on the page itself, checked in the parser thread before Readability
 * runs. Readability slows with the cube of nesting depth (1,000 nested tags
 * took about 5 s) and works element by element; news pages measured 470-1,310
 * tags, nested 17-26 deep. The tag count is also checked here, in the raw
 * HTML before parsing, so a tag flood never reaches the parser at all.
 */
const MAX_ELEMENTS = 20_000;
const MAX_DEPTH = 64;

/** Time allowed for one page, robots and redirects included. The caller's deadline still wins. */
const PAGE_TIMEOUT_MS = 8_000;

const ROBOTS_TIMEOUT_MS = 5_000;
const MAX_ROBOTS_BYTES = 512 * 1024;
const ROBOTS_CACHE_TTL_MS = 10 * 60 * 1000;
const ROBOTS_CACHE_MAX_HOSTS = 500;

const MAX_REDIRECTS = 5;

/** Below this, what Readability found is a stub (a consent wall, a teaser), not an article. */
const MIN_TEXT_CHARS = 200;

export type ExtractFailure =
  | "robots"
  | `http_${number}`
  | "timeout"
  | "too_large"
  | "not_html"
  | "no_content"
  | "error";

export type ExtractResult =
  | { url: string; ok: true; text: string }
  | { url: string; ok: false; reason: ExtractFailure };

// --- concurrency -------------------------------------------------------------

let activePages = 0;
const waiting: Array<() => void> = [];

/**
 * Resolves true once a slot is held, or false if the deadline passes first.
 * A caller that got true must call releaseSlot exactly once.
 */
function acquireSlot(deadline: number): Promise<boolean> {
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const grant = () => {
      clearTimeout(timer);
      activePages++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(grant);
      if (index !== -1) waiting.splice(index, 1);
      resolve(false);
    }, Math.max(0, deadline - Date.now()));
    waiting.push(grant);
  });
}

function releaseSlot(): void {
  activePages--;
  const next = waiting.shift();
  if (next) next();
}

// --- robots.txt --------------------------------------------------------------
//
// Ported from scripts/verify-feeds.mts: the group naming our token if there
// is one, otherwise `*`; within it the longest matching rule wins and Allow
// wins a tie, with `*` and `$` patterns (RFC 9309). A 4xx robots.txt means no
// rules; a 5xx, a 429 or no answer means everything is disallowed.

type Rule = { allow: boolean; path: string };
// Kept parsed and narrowed to the rules that apply to us, not as the raw file.
type RobotsFile = { kind: "rules"; rules: Rule[] } | { kind: "none" } | { kind: "unreachable" };

// One fetch per host, shared by every caller while it is fresh. Expiring
// entries keep a warm serverless instance from obeying an hour-old answer.
const robotsCache = new Map<string, { at: number; file: Promise<RobotsFile> }>();

function robotsFor(origin: string): Promise<RobotsFile> {
  const now = Date.now();
  const cached = robotsCache.get(origin);
  if (cached && now - cached.at < ROBOTS_CACHE_TTL_MS) return cached.file;
  if (robotsCache.size >= ROBOTS_CACHE_MAX_HOSTS) robotsCache.clear();
  const file = fetchRobots(origin).catch((): RobotsFile => ({ kind: "unreachable" }));
  robotsCache.set(origin, { at: now, file });
  return file;
}

// Redirects are walked by hand, like a page's, so a robots.txt that redirects
// into a private network is never requested there. One that can't be
// followed counts as unreachable, which refuses the host.
async function fetchRobots(origin: string): Promise<RobotsFile> {
  // Its own timeout rather than the caller's signal: the answer is shared,
  // and one caller running out of time must not record "unreachable" for
  // every other caller on the same host.
  const signal = AbortSignal.timeout(ROBOTS_TIMEOUT_MS);
  let url = new URL(`${origin}/robots.txt`);
  for (let hop = 0; ; hop++) {
    // A host resting after a refusal isn't asked for its robots.txt either.
    if (backingOff(url.origin) !== null) return { kind: "unreachable" };
    try {
      await assertPublic(url, signal);
    } catch {
      return { kind: "unreachable" };
    }
    const res = await fetch(url.href, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) return { kind: "unreachable" };
      url = new URL(location, url);
      continue;
    }
    if (res.ok) {
      const body = await readCapped(res, MAX_ROBOTS_BYTES);
      // RFC 9309 asks a crawler to read at least the first 500 KiB, so an
      // oversized file is read that far rather than refused.
      const text = decode(body.bytes, res.headers.get("content-type"));
      return { kind: "rules", rules: rulesFor(text, ROBOTS_AGENT_TOKEN) };
    }
    await res.body?.cancel().catch(() => {});
    if (res.status === 429 || res.status === 503) backOff(url.origin, res.status, res.headers.get("retry-after"));
    return res.status >= 500 || res.status === 429 ? { kind: "unreachable" } : { kind: "none" };
  }
}

function rulesFor(robotsTxt: string, agentToken: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
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
  const named = groups.filter((g) => g.agents.some((a) => a.split("/")[0].trim() === token));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

// A left-to-right scan rather than a RegExp: `*` as `.*` backtracks, and a
// robots.txt rule like `/*a*a*a*a*a*a*b` against a long path would hold the
// event loop for minutes. Taking the earliest match of each piece in turn is
// exact for patterns whose only wildcard is `*`.
function ruleMatches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith("$");
  const pieces = (anchored ? rulePath.slice(0, -1) : rulePath).split("*");
  const first = pieces[0];
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return !anchored || path.length === first.length;
  let pos = first.length;
  for (const piece of pieces.slice(1, -1)) {
    const at = path.indexOf(piece, pos);
    if (at === -1) return false;
    pos = at + piece.length;
  }
  const last = pieces[pieces.length - 1];
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return path.indexOf(last, pos) !== -1;
}

// RFC 9309 compares rules and paths percent-encoded: a URL's path arrives
// encoded (/caf%C3%A9) while a rule may be written as text (/café). Both get
// the same form: an escaped unreserved character unescaped (%7E is ~), other
// escapes upper-cased, and what the URL parser would escape (non-ASCII,
// spaces, quotes, angle brackets, backticks, braces, carets, and the single
// quote it escapes in a query) escaped.
function percentEncoded(path: string): string {
  return path
    .replace(/%([0-9a-f]{2})/gi, (escape, hex: string) => {
      const ch = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(ch) ? ch : escape.toUpperCase();
    })
    .replace(/[^\x21-\x7e]|["'<>`{}^]/gu, (ch) => {
      // encodeURIComponent leaves the single quote as it is.
      if (ch === "'") return "%27";
      try {
        return encodeURIComponent(ch);
      } catch {
        return ch;
      }
    });
}

/** Exported for tests. */
export function robotsAllows(robotsTxt: string, agentToken: string, path: string): boolean {
  return rulesAllow(rulesFor(robotsTxt, agentToken), path);
}

function rulesAllow(rules: readonly Rule[], path: string): boolean {
  const target = percentEncoded(path);
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules) {
    const rulePath = percentEncoded(rule.path);
    if (!ruleMatches(rulePath, target)) continue;
    const length = rulePath.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

async function robotsPermit(url: URL, signal: AbortSignal): Promise<boolean> {
  const file = await raceSignal(robotsFor(url.origin), signal);
  if (file.kind === "unreachable") return false;
  if (file.kind === "none") return true;
  return rulesAllow(file.rules, url.pathname + url.search);
}

// --- hosts that refused ------------------------------------------------------
//
// A host that refuses one page (401, 402, 403: "not you"; 429, 503: "not
// now") isn't asked for its other pages either, until its Retry-After (at
// least a minute, at most an hour, ten minutes when it names none).
// Otherwise every other story it covers, and a story's own fallback pages,
// would keep sending it requests after it said no. A 404 or a 500 is about
// one page, so it rests nothing.

const REFUSALS = new Set([401, 402, 403, 429, 503]);

const BACKOFF_DEFAULT_MS = 10 * 60 * 1000;
const BACKOFF_MIN_MS = 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const hostBackoff = new Map<string, { until: number; status: number }>();

function backOff(origin: string, status: number, retryAfter: string | null): void {
  let wait = BACKOFF_DEFAULT_MS;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(seconds)) wait = seconds * 1000;
    else if (Number.isFinite(at)) wait = at - Date.now();
  }
  if (hostBackoff.size >= ROBOTS_CACHE_MAX_HOSTS) {
    // Expired rests first; if every one is still running, the one that ends
    // soonest. Never all of them, which would let refusing hosts be asked early.
    const now = Date.now();
    for (const [key, entry] of hostBackoff) if (entry.until <= now) hostBackoff.delete(key);
    if (hostBackoff.size >= ROBOTS_CACHE_MAX_HOSTS) {
      let soonest: string | null = null;
      let soonestUntil = Infinity;
      for (const [key, entry] of hostBackoff) {
        if (entry.until < soonestUntil) {
          soonest = key;
          soonestUntil = entry.until;
        }
      }
      if (soonest !== null) hostBackoff.delete(soonest);
    }
  }
  hostBackoff.set(origin, {
    until: Date.now() + Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, wait)),
    status,
  });
}

/** The status a host is resting after, or null if it can be asked. */
function backingOff(origin: string): number | null {
  const entry = hostBackoff.get(origin);
  if (!entry) return null;
  if (Date.now() < entry.until) return entry.status;
  hostBackoff.delete(origin);
  return null;
}

// --- one page ----------------------------------------------------------------

class Refused extends Error {
  readonly reason: ExtractFailure;
  constructor(reason: ExtractFailure) {
    super(reason);
    this.reason = reason;
  }
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Refused("timeout"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Refused("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

// Only public web addresses, on the web's own ports. The URLs come from feeds,
// from whatever a feed's server redirects to, and, for a full report, from a
// card row a signed-in reader can write, so none of them is trusted: a URL
// that points into this server's own network (a cloud metadata address,
// localhost, a private range) is never requested.

function isPrivateAddress(ip: string): boolean {
  const host = ip.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (host.includes(":")) {
    // Only global unicast (2000::/3) is public, less the two ranges that
    // tunnel to an IPv4 address (6to4 2002::/16, Teredo 2001::/32). That
    // one rule refuses loopback, unique- and link-local, multicast, and every
    // way of writing an IPv4 address inside IPv6 (mapped, compatible, NAT64).
    const groups = ipv6Groups(host);
    if (groups === null) return true;
    if ((groups[0] & 0xe000) !== 0x2000) return true;
    return groups[0] === 0x2002 || (groups[0] === 0x2001 && groups[1] === 0);
  }
  return false;
}

/** The eight 16-bit groups of an IPv6 address, or null if it can't be read. */
function ipv6Groups(address: string): number[] | null {
  const bare = address.replace(/%.*$/, "");
  // A dotted IPv4 tail is itself an embedded IPv4 address: never public.
  if (bare.includes(".")) return null;
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.some((g) => Number.isNaN(g)) ? null : groups;
}

/** The URL's host without brackets or a trailing dot ("localhost." is localhost). */
function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/** What can be checked without the network: scheme, port, and the host as written. */
function isFetchable(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.port !== "" && url.port !== "80" && url.port !== "443") return false;
  const host = bareHost(url);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  return !isPrivateAddress(host);
}

// A name can point anywhere (169.254.169.254.nip.io is the metadata address),
// so every address it resolves to must be public. fetch resolves the name
// again when it connects, so a server that answers differently the second
// time is not caught; the stored-URL path is the one that needs that closed,
// at the point the URLs are written.
const DNS_CACHE_TTL_MS = 10 * 60 * 1000;
const DNS_NEGATIVE_TTL_MS = 30 * 1000;
const dnsCache = new Map<string, { at: number; ok: Promise<boolean> }>();

function resolvesPublicly(url: URL, signal: AbortSignal): Promise<boolean> {
  const host = bareHost(url);
  if (isIpLiteral(host)) return Promise.resolve(!isPrivateAddress(host));
  const now = Date.now();
  let entry = dnsCache.get(host);
  if (!entry || now - entry.at >= DNS_CACHE_TTL_MS) {
    if (dnsCache.size >= ROBOTS_CACHE_MAX_HOSTS) dnsCache.clear();
    const fresh: { at: number; ok: Promise<boolean> } = { at: now, ok: Promise.resolve(false) };
    fresh.ok = lookup(host, { all: true, verbatim: true })
      .then((addresses) => addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address)))
      .catch(() => false)
      .then((ok) => {
        // A failed lookup may be a passing resolver hiccup: kept only briefly.
        if (!ok) fresh.at = Date.now() - DNS_CACHE_TTL_MS + DNS_NEGATIVE_TTL_MS;
        return ok;
      });
    entry = fresh;
    dnsCache.set(host, entry);
  }
  return raceSignal(entry.ok, signal);
}

/** Throws unless the URL may be requested at all. */
async function assertPublic(url: URL, signal: AbortSignal): Promise<void> {
  if (!isFetchable(url) || !(await resolvesPublicly(url, signal))) throw new Refused("error");
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        await reader.cancel().catch(() => {});
        return { bytes: concat(chunks, total), truncated: true };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: concat(chunks, total), truncated: false };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// fetch's own text() always decodes as UTF-8, which garbles a page served in
// another charset. The header's charset wins; without one, an HTML page's own
// <meta charset> near the top, as browsers read it; otherwise UTF-8.
function decode(bytes: Uint8Array, contentType: string | null, sniffHtml = false): string {
  let label = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
  if (!label && sniffHtml) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
    // A meta tag that could be read as ASCII can't be in UTF-16, so the HTML
    // standard reads such a page as UTF-8 (and x-user-defined as windows-1252).
    if (label && /^(utf-16(le|be)?|unicode(fffe)?|ucs-2)$/i.test(label)) label = "utf-8";
    if (label && /^x-user-defined$/i.test(label)) label = "windows-1252";
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Walks the redirects by hand so robots.txt is asked before every request,
 * then returns the final page's HTML and URL. Throws Refused for every outcome other
 * than an HTML page.
 */
async function fetchHtml(startUrl: string, signal: AbortSignal): Promise<{ html: string; finalUrl: URL }> {
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    throw new Refused("error");
  }
  for (let hop = 0; ; hop++) {
    await assertPublic(url, signal);
    // Before robots.txt, so a resting host isn't asked for that either.
    const resting = backingOff(url.origin);
    if (resting !== null) throw new Refused(`http_${resting}`);
    if (!(await robotsPermit(url, signal))) throw new Refused("robots");

    const res = await fetch(url.href, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal,
    });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new Refused("error");
      try {
        url = new URL(location, url);
      } catch {
        throw new Refused("error");
      }
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      if (REFUSALS.has(res.status)) backOff(url.origin, res.status, res.headers.get("retry-after"));
      throw new Refused(`http_${res.status}`);
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) {
      await res.body?.cancel().catch(() => {});
      throw new Refused("not_html");
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new Refused("too_large");
    }
    const body = await readCapped(res, MAX_HTML_BYTES);
    if (body.truncated) throw new Refused("too_large");
    return { html: decode(body.bytes, type, true), finalUrl: url };
  }
}

/** How many `<` start a tag name, counting no further than `stopAt`. */
function openTagCount(html: string, stopAt: number): number {
  const tagStart = /<[a-zA-Z]/g;
  let count = 0;
  while (count < stopAt && tagStart.exec(html) !== null) count++;
  return count;
}

// --- the parser thread ------------------------------------------------------
//
// linkedom's parse and Readability are synchronous, and a crafted page can
// keep them busy for many seconds (3 MB of `<<` is about 1.5 million text
// nodes) or grow them past a gigabyte. So they run in a worker thread: the
// server's own event loop keeps answering whatever a page does, a page that
// runs past its time is stopped by terminating the thread, and one that runs
// past the thread's memory cap ends the thread, not the process.

/**
 * One thread per process. A Vercel function has a single vCPU, so a second
 * thread would split the CPU rather than parse any faster, and each thread
 * can grow to its heap cap, so a second would double the worst case.
 */
let parser: ParserThread | null = null;

/**
 * The longest one page may hold the parser thread. Never past the caller's
 * deadline either. Real news pages parse in about 20 ms; the heaviest real
 * shape (~16,000 tags) took up to 0.9 s on a laptop and past 1.5 s on CI's
 * slower CPU, which Vercel's single vCPU is assumed to match. Hitting this
 * marks the page's host heavy, so the margin protects real outlets.
 */
export const PARSE_TIMEOUT_MS = 3_000;

/**
 * The parser thread's heap. Both generations are set on purpose: with only
 * the old generation capped, Node 24 sometimes aborted the whole process
 * instead of ending the thread when a page reached the cap.
 */
const PARSER_HEAP = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };

/** The thread has this long to load the parser before it counts as failing to start. */
const PARSER_START_TIMEOUT_MS = 5_000;

/** An idle thread is ended after this, so its heap is given back between runs. */
const PARSER_IDLE_MS = 10_000;

/** After the thread fails to start, extraction is off for this long, then tried again. */
const PARSER_RETRY_MS = 2 * 60 * 1000;

const PARSER_LIMITS: ParserLimits = {
  maxElements: MAX_ELEMENTS,
  maxDepth: MAX_DEPTH,
  // One past the cap, so clipText can still tell a longer text from one that
  // is exactly the cap, and cut it on a sentence.
  maxChars: MAX_TEXT_CHARS + 1,
};

/** `heavy`: the page was stopped by the thread's own time limit or memory cap, not by a cheap check or the caller's deadline. */
type ParseOutcome = (ParserReply | { ok: false; reason: "timeout" }) & { heavy?: true };

type ParseJob = {
  html: string;
  /** The page's final URL, for the heavy-host check at hand-over. */
  url: URL;
  deadline: number;
  settle: (outcome: ParseOutcome) => void;
  /** Ends the wait in the queue at the deadline. */
  waitTimer?: ReturnType<typeof setTimeout>;
  /** Stops the thread at the page's time limit. */
  parseTimer?: ReturnType<typeof setTimeout>;
};

type ParserThread = { worker: Worker; ready: boolean; job: ParseJob | null; startedAt: number };

const parseQueue: ParseJob[] = [];
let parserDownUntil = 0;
let parserStartTimer: ReturnType<typeof setTimeout> | undefined;
let parserIdleTimer: ReturnType<typeof setTimeout> | undefined;

function parserAvailable(): boolean {
  return Date.now() >= parserDownUntil;
}

// A host whose page ran the thread to its time limit or memory cap has its
// other pages skipped for a while: pages are parsed one at a time, so without
// this one outlet serving such pages would use up every story's time.
const HEAVY_HOST_MS = 10 * 60 * 1000;
const heavyHosts = new Map<string, number>();

function markHeavy(url: URL): void {
  const host = bareHost(url);
  heavyHosts.delete(host);
  if (heavyHosts.size >= ROBOTS_CACHE_MAX_HOSTS) heavyHosts.delete(heavyHosts.keys().next().value!);
  heavyHosts.set(host, Date.now() + HEAVY_HOST_MS);
}

function isHeavy(url: URL): boolean {
  const host = bareHost(url);
  const until = heavyHosts.get(host);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  heavyHosts.delete(host);
  return false;
}

/** Parses `html` in the thread. Never rejects: every failure is an outcome. */
function parseInThread(html: string, url: URL, deadline: number): Promise<ParseOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const job: ParseJob = {
      html,
      url,
      deadline,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(job.waitTimer);
        clearTimeout(job.parseTimer);
        resolve(outcome);
      },
    };
    job.waitTimer = setTimeout(() => {
      const index = parseQueue.indexOf(job);
      if (index !== -1) parseQueue.splice(index, 1);
      job.settle({ ok: false, reason: "timeout" });
    }, Math.max(0, deadline - Date.now()));
    parseQueue.push(job);
    pumpParser();
  });
}

/** Hands the next queued page to the thread, starting one if needed. */
function pumpParser(): void {
  if (parseQueue.length === 0) {
    if (parser && !parser.job) scheduleParserIdle();
    return;
  }
  clearTimeout(parserIdleTimer);
  if (!parserAvailable()) {
    for (const job of parseQueue.splice(0)) job.settle({ ok: false, reason: "error" });
    return;
  }
  if (!parser) {
    startParser();
    return;
  }
  if (!parser.ready || parser.job) return;

  const job = parseQueue.shift()!;
  clearTimeout(job.waitTimer);
  // Checked here, at hand-over, so pages already queued when their host was
  // found heavy are skipped too.
  if (isHeavy(job.url)) {
    job.settle({ ok: false, reason: "too_large" });
    pumpParser();
    return;
  }
  const remaining = job.deadline - Date.now();
  if (remaining <= 0) {
    job.settle({ ok: false, reason: "timeout" });
    pumpParser();
    return;
  }
  const thread = parser;
  thread.job = job;
  const ownLimit = PARSE_TIMEOUT_MS <= remaining;
  job.parseTimer = setTimeout(() => {
    if (thread.job !== job) return;
    stopParser(thread);
    job.settle(ownLimit ? { ok: false, reason: "timeout", heavy: true } : { ok: false, reason: "timeout" });
    pumpParser();
  }, Math.min(PARSE_TIMEOUT_MS, remaining));
  try {
    thread.worker.postMessage({ html: job.html });
  } catch {
    stopParser(thread);
    job.settle({ ok: false, reason: "error" });
    pumpParser();
  }
}

function startParser(): void {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./extractWorker.mts", import.meta.url), {
      workerData: PARSER_LIMITS,
      resourceLimits: PARSER_HEAP,
    });
  } catch (err) {
    parserFailedToStart(err);
    return;
  }
  // An idle thread doesn't keep the process alive; a page being parsed has
  // its own timer, which does.
  worker.unref();
  const thread: ParserThread = { worker, ready: false, job: null, startedAt: Date.now() };
  parser = thread;
  parserStartTimer = setTimeout(() => {
    if (parser !== thread || thread.ready) return;
    stopParser(thread);
    parserFailedToStart(new Error(`not ready after ${PARSER_START_TIMEOUT_MS}ms`));
  }, PARSER_START_TIMEOUT_MS);

  worker.on("message", (message: unknown) => {
    if (parser !== thread) return;
    if (!thread.ready) {
      if ((message as { ready?: unknown } | null)?.ready !== true) return;
      thread.ready = true;
      clearTimeout(parserStartTimer);
      bestEffortLog("log", `[extract] parser thread started in ${Date.now() - thread.startedAt}ms`);
      pumpParser();
      return;
    }
    const job = thread.job;
    if (!job) return;
    thread.job = null;
    job.settle(readReply(message));
    pumpParser();
  });
  // The thread ending for any reason other than stopParser: an uncaught
  // error, a message that can't be read, or reaching its memory cap.
  const ended = (err: unknown) => {
    if (parser !== thread) return;
    stopParser(thread);
    if (!thread.ready) {
      parserFailedToStart(err);
      return;
    }
    const outOfMemory = (err as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY";
    bestEffortLog("error", `[extract] parser thread ended: ${outOfMemory ? "a page reached its memory cap" : errorText(err)}`);
    const job = thread.job;
    thread.job = null;
    // A page that needs more memory than the cap is too large to parse.
    job?.settle(outOfMemory ? { ok: false, reason: "too_large", heavy: true } : { ok: false, reason: "error" });
    pumpParser();
  };
  worker.on("error", ended);
  worker.on("messageerror", ended);
  worker.on("exit", (code) => ended(new Error(`exited with code ${code}`)));
}

/** Ends the thread. Its listeners stay, so a late event finds `parser` changed and is ignored. */
function stopParser(thread: ParserThread): void {
  if (parser === thread) parser = null;
  clearTimeout(parserStartTimer);
  void thread.worker.terminate().catch(() => {});
}

function scheduleParserIdle(): void {
  clearTimeout(parserIdleTimer);
  parserIdleTimer = setTimeout(() => {
    if (parser && !parser.job && parseQueue.length === 0) stopParser(parser);
  }, PARSER_IDLE_MS);
  parserIdleTimer.unref?.();
}

/** Logged once: extraction stays off until the retry, so nothing else tries to start a thread. */
function parserFailedToStart(err: unknown): void {
  parserDownUntil = Date.now() + PARSER_RETRY_MS;
  bestEffortLog("error", `[extract] parser thread failed to start, full text off for ${PARSER_RETRY_MS / 60_000} min: ${errorText(err)}`);
  for (const job of parseQueue.splice(0)) job.settle({ ok: false, reason: "error" });
}

/** Only a well-formed reply is believed, and its text is held to the cap here too. */
function readReply(message: unknown): ParseOutcome {
  const m = message as { ok?: unknown; text?: unknown; reason?: unknown } | null;
  if (m?.ok === true && typeof m.text === "string") return { ok: true, text: m.text.slice(0, PARSER_LIMITS.maxChars) };
  if (m?.ok === false && (m.reason === "too_large" || m.reason === "no_content")) return { ok: false, reason: m.reason };
  return { ok: false, reason: "error" };
}

function errorText(err: unknown): string {
  try {
    const code = (err as { code?: unknown } | null)?.code;
    const text = err instanceof Error ? err.message : String(err);
    return (typeof code === "string" ? `${code} ` : "") + text.slice(0, 200);
  } catch {
    return "unknown";
  }
}

/**
 * At most `max` characters, ending on a sentence when one ends in the last
 * third of the window, otherwise on a word.
 */
export function clipText(text: string, max: number = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const floor = Math.floor(max * (2 / 3));
  let sentenceEnd = -1;
  for (const match of window.matchAll(/[.!?。！？]["'”’»)]*(?=\s)/g)) {
    sentenceEnd = match.index + match[0].length;
  }
  if (sentenceEnd >= floor) return window.slice(0, sentenceEnd);
  const space = window.lastIndexOf(" ");
  return (space > 0 ? window.slice(0, space) : window).trimEnd();
}

function startsOnHeavyHost(url: string): boolean {
  try {
    return isHeavy(new URL(url));
  } catch {
    return false;
  }
}

async function extractOne(url: string, deadline: number): Promise<ExtractResult> {
  // Without a parser no page can be read, so none is requested.
  if (!parserAvailable()) return { url, ok: false, reason: "error" };
  if (startsOnHeavyHost(url)) return { url, ok: false, reason: "too_large" };
  if (!(await acquireSlot(deadline))) return { url, ok: false, reason: "timeout" };
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { url, ok: false, reason: "timeout" };
    const signal = AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, remaining));
    // Raced against the signal as well as given it: a response stream that
    // ignores the abort would otherwise hold this slot for good.
    const { html, finalUrl } = await raceSignal(fetchHtml(url, signal), signal);
    if (Date.now() >= deadline) return { url, ok: false, reason: "timeout" };
    // Counted in the raw text before parsing, in milliseconds, so a tag flood
    // never costs the parser thread its time.
    if (openTagCount(html, MAX_ELEMENTS + 1) > MAX_ELEMENTS) return { url, ok: false, reason: "too_large" };
    const parsed = await parseInThread(html, finalUrl, deadline);
    if (parsed.heavy) {
      markHeavy(finalUrl);
      if (URL.canParse(url)) markHeavy(new URL(url));
    }
    if (!parsed.ok) return { url, ok: false, reason: parsed.reason };
    if (parsed.text.length < MIN_TEXT_CHARS) return { url, ok: false, reason: "no_content" };
    return { url, ok: true, text: clipText(parsed.text) };
  } catch (err) {
    if (err instanceof Refused) return { url, ok: false, reason: err.reason };
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { url, ok: false, reason: "timeout" };
    }
    return { url, ok: false, reason: "error" };
  } finally {
    releaseSlot();
  }
}

function logSummary(results: readonly ExtractResult[], startedAt: number, label: string): void {
  try {
    const counts = new Map<string, number>();
    for (const r of results) {
      const key = r.ok ? "ok" : r.reason;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const detail = [...counts].map(([k, n]) => `${k}=${n}`).join(" ");
    const rss = Math.round(process.memoryUsage().rss / 1048576);
    bestEffortLog("log", `[extract] ${label} ${results.length} pages: ${detail} in ${Date.now() - startedAt}ms rss=${rss}MB`);
  } catch {
    // A summary line must never cost the caller its result.
  }
}

/**
 * Extracts each URL's article text, never past `deadline` (epoch ms). The
 * result is in the same order as `urls`. Never rejects: a page that fails
 * for any reason, or isn't finished by the deadline, is `{ ok: false }` and
 * the caller writes from what it has.
 *
 * A page still downloading or being parsed at the deadline is stopped there.
 */
export async function extractArticles(
  urls: readonly string[],
  { deadline, label = "" }: { deadline: number; label?: string }
): Promise<ExtractResult[]> {
  const startedAt = Date.now();
  const results = await extractBatch(urls, deadline);
  logSummary(results, startedAt, label);
  return results;
}

async function extractBatch(urls: readonly string[], deadline: number): Promise<ExtractResult[]> {
  let results: ExtractResult[];
  try {
    const timedOut = (url: string): ExtractResult => ({ url, ok: false, reason: "timeout" });
    const pending = urls.map((url) => extractOne(url, deadline));
    // The race is the guarantee: whatever a fetch does with its signal, the
    // caller gets its answer at the deadline. Pages still running finish (or
    // abort) in the background and release their slots.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new Promise<"stop">((resolve) => {
      timer = setTimeout(() => resolve("stop"), Math.max(0, deadline - Date.now()));
    });
    const settled = urls.map<ExtractResult | null>(() => null);
    const all = Promise.all(
      pending.map((p, i) =>
        p.then((r) => {
          settled[i] = r;
        })
      )
    );
    await Promise.race([all, stop]);
    clearTimeout(timer);
    results = settled.map((r, i) => r ?? timedOut(urls[i]));
  } catch {
    results = urls.map((url) => ({ url, ok: false, reason: "error" }));
  }
  return results;
}

// --- writing from it ---------------------------------------------------------

/**
 * Pages tried per story. More than the full texts used, so a blocked outlet
 * near the top of the list doesn't leave the writer with nothing when a later
 * one would have loaded.
 */
export const MAX_PAGES_PER_STORY = 5;

/**
 * Full texts handed to the writer per story: what keeps a large cluster's
 * input bounded. At 1,500 characters each, three add at most about 1,500
 * input tokens to a card, which is what the digest's spend hold is sized
 * against.
 */
export const MAX_FULL_TEXTS_PER_STORY = 3;

/**
 * Least time left before a story starts another round of pages. A round
 * that ends at the deadline does so on a timer, and a timer can fire a
 * millisecond or so before `Date.now()` reaches the time it was set for, so
 * "any time left" would start fallback pages only to abandon them at once.
 */
export const MIN_ROUND_TIME_MS = 20;

/**
 * Told to the writer whenever it gets full text. The last sentence keeps the
 * stored card and report from reproducing an article's own wording.
 */
export const FULL_TEXT_INSTRUCTION =
  "Write from the full-text articles: every fact you state must come from them. The other coverage listed after them gave only a headline and a feed summary; it shows who else reported the story, not facts to use. Write in your own words: never copy sentences from the articles, and quote only short remarks, attributed to who said them.";

/**
 * A story's full texts, fetched only as far as needed: its first
 * MAX_FULL_TEXTS_PER_STORY pages, then, for each one that failed, the next
 * page down, up to MAX_PAGES_PER_STORY. Fallbacks therefore join the shared
 * queue behind every other story's first pages, and a story whose first
 * pages all load fetches nothing more.
 *
 * `results[i]` belongs to `urls[i]`; a page never tried is `undefined`.
 */
export async function extractForStory(
  urls: readonly string[],
  { deadline, label = "" }: { deadline: number; label?: string }
): Promise<(ExtractResult | undefined)[]> {
  const startedAt = Date.now();
  const limit = Math.min(urls.length, MAX_PAGES_PER_STORY);
  const results: (ExtractResult | undefined)[] = [];
  let next = 0;
  let ok = 0;
  while (ok < MAX_FULL_TEXTS_PER_STORY && next < limit && deadline - Date.now() >= MIN_ROUND_TIME_MS) {
    const batch = urls.slice(next, Math.min(limit, next + MAX_FULL_TEXTS_PER_STORY - ok));
    const answers = await extractBatch(batch, deadline);
    answers.forEach((r, i) => {
      results[next + i] = r;
      if (r.ok) ok++;
    });
    next += batch.length;
  }
  // One line per story, however many rounds it took.
  logSummary(results.filter((r): r is ExtractResult => r !== undefined), startedAt, label);
  return results;
}

/**
 * Splits a story's sources, already in display order, into the ones whose
 * text was extracted (at most MAX_FULL_TEXTS_PER_STORY, in that same order)
 * and everything else, also in order. `results[i]` belongs to `items[i]`; a
 * missing result counts as no text. An extracted source past the cap joins
 * the headline-only group, so nothing is dropped from the story.
 */
export function splitByFullText<T>(
  items: readonly T[],
  results: readonly (ExtractResult | undefined)[]
): { fullText: { item: T; text: string }[]; headlineOnly: T[] } {
  const fullText: { item: T; text: string }[] = [];
  const headlineOnly: T[] = [];
  items.forEach((item, i) => {
    const r = results[i];
    if (r?.ok && fullText.length < MAX_FULL_TEXTS_PER_STORY) fullText.push({ item, text: r.text });
    else headlineOnly.push(item);
  });
  return { fullText, headlineOnly };
}

/** For tests: forget cached robots answers, host back-offs and heavy hosts, and start over with no parser thread. */
export function resetExtractStateForTests(): void {
  if (parser) {
    const thread = parser;
    stopParser(thread);
    thread.job?.settle({ ok: false, reason: "error" });
    thread.job = null;
  }
  heavyHosts.clear();
  for (const job of parseQueue.splice(0)) job.settle({ ok: false, reason: "error" });
  clearTimeout(parserIdleTimer);
  parserDownUntil = 0;
  robotsCache.clear();
  hostBackoff.clear();
  dnsCache.clear();
}
