import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Names resolve to a public address without a real DNS query.
vi.mock("node:dns/promises", () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  return { lookup, default: { lookup } };
});
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  extractArticles,
  extractForStory,
  MAX_CONCURRENT_PAGES,
  MAX_PAGES_PER_STORY,
  MIN_ROUND_TIME_MS,
  resetExtractStateForTests,
  robotsAllows,
  type ExtractResult,
} from "@/lib/extract";

// QA round 2: the round-1 fixes pushed on, extractForStory's fallback rounds
// and its place in the shared queue. A fake web throughout; an unknown URL
// fails the test, so nothing here reaches the network.


const ARTICLE = readFileSync(path.join(__dirname, "fixtures/extract/article.html"), "utf8");
const TOKEN = "H72NewsAggregator";

type Handler = (req: { url: string; init: RequestInit }) => Response | Promise<Response>;

function serve(routes: Record<string, Handler>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const handler = routes[url];
    if (handler) return handler({ url, init });
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fake);
  return { calls, pageCalls: () => calls.filter((c) => !c.url.endsWith("/robots.txt")).map((c) => c.url) };
}

const page = (body: string | Uint8Array<ArrayBuffer> = ARTICLE, type = "text/html; charset=utf-8") => () =>
  new Response(body, { status: 200, headers: { "content-type": type } });
const status = (code: number) => () => new Response("", { status: code });
const redirect = (location: string, code = 302) => () => new Response(null, { status: code, headers: { location } });
const delayed = (ms: number, make: () => Response): Handler => () => new Promise((r) => setTimeout(() => r(make()), ms));
const deaf: Handler = () => new Promise<Response>(() => {});

const soon = (ms: number) => Date.now() + ms;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const outcome = (r: ExtractResult | undefined) => (r === undefined ? "untried" : r.ok ? "ok" : r.reason);
const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));

async function expectAllSlotsFree() {
  let inFlight = 0;
  let peak = 0;
  const routes: Record<string, Handler> = {};
  const urls = Array.from({ length: MAX_CONCURRENT_PAGES }, (_, i) => `https://probe.example/${i}`);
  for (const url of urls) {
    routes[url] = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(60);
      inFlight--;
      return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
    };
  }
  serve(routes);
  resetExtractStateForTests();
  const results = await extractArticles(urls, { deadline: soon(3_000) });
  expect(results.map(outcome).every((r) => r === "ok")).toBe(true);
  expect(peak).toBe(MAX_CONCURRENT_PAGES);
}

beforeEach(() => {
  resetExtractStateForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- robots matching, percent-encoding ----------------------------------------

describe("robots rules compared percent-encoded", () => {
  it.each([
    // `*` and `$` combined with non-ASCII
    ["Disallow: /*/café$", "/x/caf%C3%A9", false],
    ["Disallow: /*/café$", "/x/caf%C3%A9/more", true],
    ["Disallow: /caf*é", "/caf-anything-%C3%A9", false],
    ["Disallow: /*%a9$", "/x/caf%C3%A9", false],
    // a space in a rule is %20 in a URL path
    ["Disallow: /a b", new URL("https://x.example/a b/c").pathname, false],
    // lower-case hex in both, mixed with a `*`
    ["Disallow: /*%c3%a9$", "/x/caf%c3%a9", false],
    // Arabic rule against the URL parser's own encoding, with a wildcard
    ["Disallow: /*/أخبار", new URL("https://x.example/ar/أخبار/1").pathname, false],
    // a literal % that is not an escape is left alone on both sides
    ["Disallow: /100%", "/100%/x", false],
    // query strings arrive encoded too
    ["Disallow: /*?q=café", (() => { const u = new URL("https://x.example/s?q=café"); return u.pathname + u.search; })(), false],
  ])("%j against %s → allowed=%s", (rule, p, allowed) => {
    expect(robotsAllows(`User-agent: *\n${rule}\n`, TOKEN, p)).toBe(allowed);
  });

  it("an Allow and a Disallow for the same path, one written as text and one encoded, tie: Allow wins", () => {
    const txt = "User-agent: *\nDisallow: /caf%C3%A9\nAllow: /café\n";
    expect(robotsAllows(txt, TOKEN, "/caf%C3%A9/x")).toBe(true);
  });

  it("longest match is measured after encoding: an encoded Disallow outranks a shorter ASCII Allow", () => {
    const txt = "User-agent: *\nAllow: /caf\nDisallow: /café\n";
    expect(robotsAllows(txt, TOKEN, "/caf%C3%A9/x")).toBe(false);
  });

  it("a lone surrogate in a rule or path doesn't throw", () => {
    expect(() => robotsAllows("User-agent: *\nDisallow: /\uD800\n", TOKEN, "/a\uDC00")).not.toThrow();
  });

  // RFC 9309 2.2.2: a percent-encoded unreserved ASCII octet is decoded before
  // comparing. /%61dmin is /admin; a %7E in a rule is "~".
  it("an encoded unreserved character is decoded before comparing", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /admin\n", TOKEN, "/%61dmin/page")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /%7Euser\n", TOKEN, "/~user/page")).toBe(false);
  });
});

describe("robots wildcard matching cost", () => {
  // Each `*` becomes `.*` in one backtracking regex, so a rule with many
  // wildcards and a literal that never occurs is exponential in the path.
  const rule = "/" + "*-".repeat(7) + "*Z"; // 8 wildcards
  const target = "/news/2026/10/03/" + "a-".repeat(40) + "story"; // a 102-char path

  it("one rule with 8 wildcards blocks the event loop for over a second", () => {
    const started = performance.now();
    robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, TOKEN, target);
    const took = performance.now() - started;
    console.warn(`[qa2] 8-wildcard rule on a ${target.length}-char path: ${Math.round(took)} ms`);
    expect(took).toBeLessThan(100);
  });

  it("such a robots.txt holds extractArticles far past its deadline", async () => {
    // A few characters longer than the unit case, so the stall clearly
    // outlasts timer noise on a loaded machine.
    const url = `https://wild.example${target}${"-b".repeat(6)}`;
    serve({
      "https://wild.example/robots.txt": () => new Response(`User-agent: *\nDisallow: ${rule}\n`),
      [url]: page(),
    });
    const started = Date.now();
    await extractArticles([url], { deadline: soon(200) });
    const took = Date.now() - started;
    console.warn(`[qa2] extractArticles with a 200 ms deadline returned after ${took} ms`);
    expect(took).toBeLessThan(1_500);
  });
});

// --- robots.txt redirects -----------------------------------------------------

describe("robots.txt redirects, walked by hand", () => {
  it("a robots.txt redirecting to itself is unreachable after the hop cap: the page is refused, unrequested", async () => {
    const { calls, pageCalls } = serve({
      "https://loop.example/robots.txt": redirect("/robots.txt"),
      "https://loop.example/a": page(),
    });
    const [r] = await extractArticles(["https://loop.example/a"], { deadline: soon(5_000) });
    expect(outcome(r)).toBe("robots");
    expect(pageCalls()).toEqual([]);
    // 1 request + 5 followed redirects, then refuse
    expect(calls.filter((c) => c.url.endsWith("/robots.txt"))).toHaveLength(6);
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  it("a relative Location resolves against the robots.txt URL, and its rules are obeyed", async () => {
    const { pageCalls } = serve({
      "https://rel.example/robots.txt": redirect("/seo/robots-live.txt", 301),
      "https://rel.example/seo/robots-live.txt": () => new Response("User-agent: *\nDisallow: /a\n"),
      "https://rel.example/a": page(),
    });
    const [r] = await extractArticles(["https://rel.example/a"], { deadline: soon(5_000) });
    expect(outcome(r)).toBe("robots");
    expect(pageCalls()).not.toContain("https://rel.example/a");
  });

  it("a protocol-relative Location to another public host is followed", async () => {
    serve({
      "https://pr.example/robots.txt": redirect("//cdn.pr.example/robots.txt"),
      "https://cdn.pr.example/robots.txt": () => new Response("User-agent: *\nDisallow: /\n"),
      "https://pr.example/a": page(),
    });
    const [r] = await extractArticles(["https://pr.example/a"], { deadline: soon(5_000) });
    expect(outcome(r)).toBe("robots");
  });

  it.each([
    ["an unparsable Location", "http://[bad"],
    ["a non-http scheme", "ftp://files.example/robots.txt"],
    ["a trailing-dot loopback", "http://127.0.0.1./robots.txt"],
    ["a trailing-dot metadata host", "http://metadata.google.internal./robots.txt"],
    ["an IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/robots.txt"],
  ])("%s refuses the host without requesting it", async (_name, location) => {
    const { calls } = serve({
      "https://bad.example/robots.txt": redirect(location),
      "https://bad.example/a": page(),
    });
    const [r] = await extractArticles(["https://bad.example/a"], { deadline: soon(5_000) });
    expect(outcome(r)).toBe("robots");
    expect(calls.map((c) => c.url)).toEqual(["https://bad.example/robots.txt"]);
  });

  it("exactly five robots redirects are followed; the rules at the end apply", async () => {
    const routes: Record<string, Handler> = { "https://five.example/a": page() };
    routes["https://five.example/robots.txt"] = redirect("https://five.example/r1");
    for (let i = 1; i < 5; i++) routes[`https://five.example/r${i}`] = redirect(`https://five.example/r${i + 1}`);
    routes["https://five.example/r5"] = () => new Response("User-agent: *\nAllow: /\n");
    const { pageCalls } = serve(routes);
    const [r] = await extractArticles(["https://five.example/a"], { deadline: soon(5_000) });
    expect(outcome(r)).toBe("ok");
    expect(pageCalls()).toContain("https://five.example/a");
  });

  it("a sixth robots redirect refuses the host", async () => {
    const routes: Record<string, Handler> = { "https://six.example/a": page() };
    routes["https://six.example/robots.txt"] = redirect("https://six.example/r1");
    for (let i = 1; i <= 5; i++) routes[`https://six.example/r${i}`] = redirect(`https://six.example/r${i + 1}`);
    routes["https://six.example/r6"] = () => new Response("User-agent: *\nAllow: /\n");
    const { calls } = serve(routes);
    const [r] = await extractArticles(["https://six.example/a"], { deadline: soon(5_000) });
    expect(outcome(r)).toBe("robots");
    expect(calls.map((c) => c.url)).not.toContain("https://six.example/r6");
    expect(calls.map((c) => c.url)).not.toContain("https://six.example/a");
  });
});

// --- trailing dots on literal addresses -----------------------------------------

describe("trailing dots on private literals", () => {
  it.each([
    "http://127.0.0.1./admin",
    "http://169.254.169.254./latest/meta-data",
    "http://10.0.0.1../x",
    "http://0x7f.0.0.1./",
    "http://2130706433./",
    "http://LOCALHOST./",
    "http://foo.localhost./",
    "http://metadata.google.internal./computeMetadata",
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
  ])("%s is refused unrequested", async (url) => {
    const { calls } = serve({});
    const [r] = await extractArticles([url], { deadline: soon(2_000) });
    expect(outcome(r)).toBe("error");
    expect(calls).toEqual([]);
  });

  it("a redirect into a trailing-dot private literal is refused before it is requested", async () => {
    const { calls } = serve({ "https://news.example/a": redirect("http://169.254.169.254./latest") });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(2_000) });
    expect(outcome(r)).toBe("error");
    expect(calls.some((c) => c.url.includes("169.254"))).toBe(false);
  });
});

// --- <meta charset> -----------------------------------------------------------

describe("charset from the page", () => {
  const withMeta = (meta: string) =>
    ARTICLE.replace('<meta charset="utf-8">', meta).replace("The city council voted", "Le conseil a voté");

  it("reads charset from <meta http-equiv content='text/html; charset=...'>", async () => {
    const bytes = latin1(withMeta('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'));
    serve({ "https://fr.example/a": page(bytes, "text/html") });
    const [r] = await extractArticles(["https://fr.example/a"], { deadline: soon(5_000) });
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });

  it("reads an unquoted <meta charset=iso-8859-1>", async () => {
    const bytes = latin1(withMeta("<meta charset=iso-8859-1>"));
    serve({ "https://fr.example/a": page(bytes, "text/html") });
    const [r] = await extractArticles(["https://fr.example/a"], { deadline: soon(5_000) });
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });

  it("an unknown <meta charset> label falls back to UTF-8 and still extracts", async () => {
    const utf8 = new TextEncoder().encode(withMeta('<meta charset="x-not-a-charset">'));
    serve({ "https://fr.example/a": page(utf8, "text/html") });
    const [r] = await extractArticles(["https://fr.example/a"], { deadline: soon(5_000) });
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });

  it("a header charset with an unknown label falls back to UTF-8 (the meta is not consulted)", async () => {
    const utf8 = new TextEncoder().encode(withMeta('<meta charset="utf-8">'));
    serve({ "https://fr.example/a": page(utf8, "text/html; charset=bogus") });
    const [r] = await extractArticles(["https://fr.example/a"], { deadline: soon(5_000) });
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });

  // HTML's "get an encoding" rule: a meta naming UTF-16 is read as UTF-8,
  // since a page whose bytes could be read to find that meta isn't UTF-16.
  it("<meta charset=utf-16> on an ASCII-compatible page is read as UTF-8", async () => {
    const utf8 = new TextEncoder().encode(withMeta('<meta charset="utf-16">'));
    serve({ "https://u16.example/a": page(utf8, "text/html") });
    const [r] = await extractArticles(["https://u16.example/a"], { deadline: soon(5_000) });
    console.warn(`[qa2] utf-16 meta: ${r.ok ? `ok, text starts ${JSON.stringify(r.text.slice(0, 40))}` : r.reason}`);
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });
});

// --- extractForStory ----------------------------------------------------------

describe("extractForStory: rounds and alignment", () => {
  const urls = Array.from({ length: 7 }, (_, i) => `https://s${i}.example/story`);
  const routesWith = (blocked: number[], code = 403) => {
    const routes: Record<string, Handler> = {};
    urls.forEach((u, i) => (routes[u] = blocked.includes(i) ? status(code) : page()));
    return routes;
  };

  it("takes as many rounds as it needs: a failed fallback earns another fallback", async () => {
    const { pageCalls } = serve(routesWith([1, 3]));
    const results = await extractForStory(urls, { deadline: soon(5_000) });
    expect(pageCalls()).toEqual(urls.slice(0, 5));
    expect(results.map(outcome)).toEqual(["ok", "http_403", "ok", "http_403", "ok"]);
  });

  it("one failure fetches exactly one more page; the rest stay untried", async () => {
    const { pageCalls } = serve(routesWith([1]));
    const results = await extractForStory(urls, { deadline: soon(5_000) });
    expect(pageCalls()).toEqual(urls.slice(0, 4));
    expect(results).toHaveLength(4);
    expect(results.map(outcome)).toEqual(["ok", "http_403", "ok", "ok"]);
  });

  it("results line up with urls even when a later round's pages finish in reverse order", async () => {
    const routes = routesWith([0, 1, 2]);
    routes[urls[3]] = delayed(120, () => new Response("", { status: 404 }));
    routes[urls[4]] = delayed(10, () => new Response(ARTICLE, { headers: { "content-type": "text/html" } }));
    serve(routes);
    const results = await extractForStory(urls, { deadline: soon(5_000) });
    expect(results.map((r) => r?.url)).toEqual(urls.slice(0, 5));
    expect(results.map(outcome)).toEqual(["http_403", "http_403", "http_403", "http_404", "ok"]);
  });

  it("never requests the same URL twice, whatever the refusal", async () => {
    for (const code of [401, 403, 429, 503]) {
      resetExtractStateForTests();
      const { pageCalls } = serve(routesWith([0, 1, 2, 3, 4, 5, 6], code));
      await extractForStory(urls, { deadline: soon(5_000) });
      const requested = pageCalls();
      expect(new Set(requested).size).toBe(requested.length);
      expect(requested).toHaveLength(MAX_PAGES_PER_STORY);
    }
  });

  it("a robots refusal counts as a failure and earns a fallback, with no request to the refused page", async () => {
    const routes = routesWith([]);
    routes["https://s0.example/robots.txt"] = () => new Response("User-agent: *\nDisallow: /\n");
    const { pageCalls } = serve(routes);
    const results = await extractForStory(urls, { deadline: soon(5_000) });
    expect(pageCalls()).toEqual(urls.slice(1, 4));
    expect(results.map(outcome)).toEqual(["robots", "ok", "ok", "ok"]);
  });

  it("never rejects, whatever the URLs and whatever fetch does", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("synchronous throw from fetch");
    });
    const results = await extractForStory(["", "not a url", "javascript:alert(1)", "https://x.example/a", "file:///etc/passwd"], {
      deadline: soon(2_000),
    });
    expect(results.map(outcome)).toEqual(["error", "error", "error", "robots", "error"]);
  });

  it("a deadline already passed fetches nothing and returns an empty list", async () => {
    const { calls } = serve(routesWith([]));
    expect(await extractForStory(urls, { deadline: Date.now() - 1 })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a fallback round started just before the deadline still ends at the deadline", async () => {
    const routes = routesWith([]);
    for (const u of urls.slice(0, 3)) routes[u] = delayed(150, () => new Response("", { status: 403 }));
    for (const u of urls.slice(3)) routes[u] = deaf;
    const { pageCalls } = serve(routes);
    const started = Date.now();
    const results = await extractForStory(urls, { deadline: soon(250) });
    const took = Date.now() - started;
    expect(results.map(outcome)).toEqual(["http_403", "http_403", "http_403", "timeout", "timeout"]);
    expect(pageCalls()).toEqual(urls.slice(0, 5));
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(1_500);
  });

  // Tarek's rule: no retries to get around a 401/403/429. The fallback is
  // meant to reach a different outlet; nothing stops it landing on the same
  // host that just refused, since a cluster can hold two articles from one
  // outlet. Stated here as the stricter reading; a decision, not a defect,
  // if the looser one is intended.
  it("after a host answers 429, the story's fallback doesn't go back to that host", async () => {
    const story = [
      "https://busy.example/first",
      "https://b.example/1",
      "https://c.example/1",
      "https://busy.example/second",
      "https://d.example/1",
    ];
    const { pageCalls } = serve({
      [story[0]]: status(429),
      [story[1]]: page(),
      [story[2]]: page(),
      [story[3]]: page(),
      [story[4]]: page(),
    });
    await extractForStory(story, { deadline: soon(5_000) });
    expect(pageCalls().filter((u) => u.startsWith("https://busy.example/"))).toEqual([story[0]]);
  });
});

describe("extractForStory in the shared queue", () => {
  it("other stories' first pages are served before one story's fallbacks", async () => {
    const order: string[] = [];
    const routes: Record<string, Handler> = {};
    const story = (name: string) => Array.from({ length: 5 }, (_, i) => `https://${name}${i}.example/p`);
    const A = story("a");
    const others = ["b", "c", "d"].map(story);
    // A's first three are refused at once; everyone else's pages are slow, so
    // the queue is still full of first pages when A's fallbacks join it.
    A.forEach((u, i) => {
      routes[u] = ({ url }) => {
        order.push(url);
        return i < 3 ? new Response("", { status: 403 }) : new Response(ARTICLE, { headers: { "content-type": "text/html" } });
      };
    });
    for (const s of others) {
      for (const u of s) {
        routes[u] = async ({ url }) => {
          order.push(url);
          await sleep(80);
          return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
        };
      }
    }
    serve(routes);
    const runs = [A, ...others].map((s) => extractForStory(s, { deadline: soon(5_000) }));
    const [a, ...rest] = await Promise.all(runs);
    expect(a.map(outcome)).toEqual(["http_403", "http_403", "http_403", "ok", "ok"]);
    for (const r of rest) expect(r.map(outcome)).toEqual(["ok", "ok", "ok"]);
    const firstPages = others.flatMap((s) => s.slice(0, 3));
    const lastFirstPage = Math.max(...firstPages.map((u) => order.indexOf(u)));
    expect(order.indexOf(A[3])).toBeGreaterThan(lastFirstPage);
    expect(order.indexOf(A[4])).toBeGreaterThan(lastFirstPage);
  });

  it("concurrent stories against deaf servers answer at their deadline and leave every slot free", async () => {
    const routes: Record<string, Handler> = {};
    const stories = Array.from({ length: 4 }, (_, s) => Array.from({ length: 5 }, (_, i) => `https://deaf${s}-${i}.example/p`));
    for (const s of stories) for (const u of s) routes[u] = deaf;
    serve(routes);
    const started = Date.now();
    const results = await Promise.all(stories.map((s) => extractForStory(s, { deadline: soon(250) })));
    expect(Date.now() - started).toBeLessThan(1_500);
    for (const r of results) expect(r.map(outcome)).toEqual(["timeout", "timeout", "timeout"]);
    await sleep(50);
    await expectAllSlotsFree();
  });

  it("starts no round of pages with less than MIN_ROUND_TIME_MS left, so a deadline timer firing early can't start fallbacks", async () => {
    const asked: string[] = [];
    const urls = Array.from({ length: 5 }, (_, i) => `https://margin-${i}.example/p`);
    const routes: Record<string, Handler> = {};
    for (const u of urls) {
      routes[u] = ({ url }) => {
        asked.push(url);
        return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
      };
    }
    serve(routes);
    const result = await extractForStory(urls, { deadline: soon(MIN_ROUND_TIME_MS - 5) });
    expect(result.every((r) => r === undefined)).toBe(true);
    expect(asked).toEqual([]);
  });

  it("slow robots.txt on fallback hosts doesn't hold the caller past its deadline", async () => {
    const story = Array.from({ length: 5 }, (_, i) => `https://slowrobots${i}.example/p`);
    const routes: Record<string, Handler> = {};
    story.slice(0, 3).forEach((u) => (routes[u] = status(403)));
    story.slice(3).forEach((u) => {
      routes[u] = page();
      routes[new URL("/robots.txt", u).href] = deaf;
    });
    serve(routes);
    const started = Date.now();
    const results = await extractForStory(story, { deadline: soon(300) });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(results.map(outcome)).toEqual(["http_403", "http_403", "http_403", "timeout", "timeout"]);
  });
});
