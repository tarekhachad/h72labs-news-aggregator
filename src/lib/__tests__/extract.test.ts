import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No real DNS query: names resolve to a public address unless a test says
// otherwise through mockLookup.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  clipText,
  extractArticles,
  extractForStory,
  FULL_TEXT_INSTRUCTION,
  MAX_FULL_TEXTS_PER_STORY,
  MAX_PAGES_PER_STORY,
  MAX_CONCURRENT_PAGES,
  MAX_HTML_BYTES,
  MAX_TEXT_CHARS,
  resetExtractStateForTests,
  robotsAllows,
} from "@/lib/extract";

const FIXTURES = path.join(__dirname, "fixtures/extract");
const ARTICLE = readFileSync(path.join(FIXTURES, "article.html"), "utf8");
const STUB = readFileSync(path.join(FIXTURES, "stub.html"), "utf8");

type Handler = (req: { url: string; init: RequestInit }) => Response | Promise<Response>;

/**
 * A fake web: every request goes to `routes[url]`, and an unknown URL fails
 * the test rather than reaching the network. robots.txt is a 404 (no rules)
 * unless a route says otherwise.
 */
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
  return { calls, pageCalls: () => calls.filter((c) => !c.url.endsWith("/robots.txt")) };
}

const html = (body: string, headers: Record<string, string> = {}) => () =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

/** Never answers on its own; rejects the way fetch does when its signal aborts. */
const hang: Handler = ({ init }) =>
  new Promise<Response>((_, reject) => {
    const signal = init.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const soon = (ms: number) => Date.now() + ms;

beforeEach(() => {
  resetExtractStateForTests();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extractArticles", () => {
  it("returns the article body, not the menus, at most MAX_TEXT_CHARS", async () => {
    serve({ "https://news.example/a": html(ARTICLE) });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("The city council voted on Tuesday");
    expect(r.text).not.toContain("Most read");
    expect(r.text).not.toContain("window.analytics");
    expect(r.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });

  it("sends an honest User-Agent naming the app, on the page and on robots.txt", async () => {
    const { calls } = serve({ "https://news.example/a": html(ARTICLE) });
    await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
    expect(calls.map((c) => c.url)).toEqual(["https://news.example/robots.txt", "https://news.example/a"]);
    for (const c of calls) {
      expect(new Headers(c.init.headers).get("user-agent")).toContain("H72NewsAggregator");
    }
  });

  it("keeps results in the order the URLs were given", async () => {
    serve({
      "https://a.example/1": html(STUB),
      "https://b.example/2": html(ARTICLE),
      "https://c.example/3": () => new Response("no", { status: 403 }),
    });
    const results = await extractArticles(
      ["https://a.example/1", "https://b.example/2", "https://c.example/3"],
      { deadline: soon(5_000) }
    );
    expect(results.map((r) => r.url)).toEqual(["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["no_content", "ok", "http_403"]);
  });

  describe("blocked stays blocked", () => {
    it.each([401, 402, 403, 404, 429, 500, 503])("a %i is the answer: one request, no retry", async (status) => {
      const { pageCalls } = serve({ "https://news.example/a": () => new Response("nope", { status }) });
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
      expect(r).toEqual({ url: "https://news.example/a", ok: false, reason: `http_${status}` });
      expect(pageCalls()).toHaveLength(1);
    });

    it("never requests a page robots.txt disallows", async () => {
      const { pageCalls } = serve({
        "https://news.example/robots.txt": () => new Response("User-agent: *\nDisallow: /a\n"),
        "https://news.example/a": html(ARTICLE),
      });
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
      expect(r).toEqual({ url: "https://news.example/a", ok: false, reason: "robots" });
      expect(pageCalls()).toHaveLength(0);
    });

    it("obeys a group that names our agent over the * group", async () => {
      serve({
        "https://news.example/robots.txt": () =>
          new Response("User-agent: *\nAllow: /\n\nUser-agent: H72NewsAggregator\nDisallow: /\n"),
        "https://news.example/a": html(ARTICLE),
      });
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("robots");
    });

    it("treats an unreachable robots.txt (5xx, 429, no answer) as a refusal", async () => {
      serve({
        "https://five.example/robots.txt": () => new Response("", { status: 503 }),
        "https://many.example/robots.txt": () => new Response("", { status: 429 }),
        "https://down.example/robots.txt": () => {
          throw new TypeError("fetch failed");
        },
        "https://five.example/a": html(ARTICLE),
        "https://many.example/a": html(ARTICLE),
        "https://down.example/a": html(ARTICLE),
      });
      const results = await extractArticles(
        ["https://five.example/a", "https://many.example/a", "https://down.example/a"],
        { deadline: soon(5_000) }
      );
      expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["robots", "robots", "robots"]);
    });

    it("checks robots.txt on every redirect hop, and stops at a hop that disallows", async () => {
      const { calls } = serve({
        "https://short.example/x": () => new Response(null, { status: 301, headers: { location: "https://news.example/story" } }),
        "https://news.example/robots.txt": () => new Response("User-agent: *\nDisallow: /story\n"),
        "https://news.example/story": html(ARTICLE),
      });
      const [r] = await extractArticles(["https://short.example/x"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("robots");
      expect(calls.map((c) => c.url)).toEqual([
        "https://short.example/robots.txt",
        "https://short.example/x",
        "https://news.example/robots.txt",
      ]);
    });

    it("follows an allowed redirect by hand, asking each host's robots.txt first", async () => {
      const { calls } = serve({
        "https://short.example/x": () => new Response(null, { status: 302, headers: { location: "/y" } }),
        "https://short.example/y": () => new Response(null, { status: 302, headers: { location: "https://news.example/story" } }),
        "https://news.example/story": html(ARTICLE),
      });
      const [r] = await extractArticles(["https://short.example/x"], { deadline: soon(5_000) });
      expect(r.ok).toBe(true);
      expect(calls.map((c) => c.url)).toEqual([
        "https://short.example/robots.txt",
        "https://short.example/x",
        "https://short.example/y",
        "https://news.example/robots.txt",
        "https://news.example/story",
      ]);
      for (const c of calls.filter((c) => !c.url.endsWith("robots.txt"))) {
        expect(c.init.redirect).toBe("manual");
      }
    });

    it("gives up on a redirect loop", async () => {
      serve({
        "https://loop.example/a": () => new Response(null, { status: 302, headers: { location: "/b" } }),
        "https://loop.example/b": () => new Response(null, { status: 302, headers: { location: "/a" } }),
      });
      const [r] = await extractArticles(["https://loop.example/a"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("error");
    });

    it("won't follow a redirect into a private address", async () => {
      const { calls } = serve({
        "https://news.example/a": () =>
          new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
      });
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("error");
      expect(calls.some((c) => c.url.includes("169.254"))).toBe(false);
    });

    it("asks a host's robots.txt once for many pages", async () => {
      const { calls } = serve({
        "https://news.example/a": html(ARTICLE),
        "https://news.example/b": html(ARTICLE),
        "https://news.example/c": html(ARTICLE),
      });
      await extractArticles(["https://news.example/a", "https://news.example/b", "https://news.example/c"], {
        deadline: soon(5_000),
      });
      expect(calls.filter((c) => c.url.endsWith("/robots.txt"))).toHaveLength(1);
    });
  });

  describe("what isn't an article", () => {
    it("refuses anything but HTML", async () => {
      serve({
        "https://news.example/a.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
        "https://news.example/feed": () => new Response("<rss/>", { headers: { "content-type": "application/rss+xml" } }),
        "https://news.example/none": () => new Response(ARTICLE),
      });
      const results = await extractArticles(
        ["https://news.example/a.pdf", "https://news.example/feed", "https://news.example/none"],
        { deadline: soon(5_000) }
      );
      // A Response built from a string defaults to text/plain, which is not HTML either.
      expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["not_html", "not_html", "not_html"]);
    });

    it("refuses a page that declares itself too large without reading it", async () => {
      const cancel = vi.fn();
      serve({
        "https://news.example/big": () =>
          new Response(new ReadableStream({ start() {}, cancel }), {
            headers: { "content-type": "text/html", "content-length": String(MAX_HTML_BYTES + 1) },
          }),
      });
      const [r] = await extractArticles(["https://news.example/big"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("too_large");
      expect(cancel).toHaveBeenCalled();
    });

    it("stops reading a page that turns out too large", async () => {
      const chunk = new Uint8Array(256 * 1024).fill(0x61);
      let sent = 0;
      serve({
        "https://news.example/big": () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                sent += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
            { headers: { "content-type": "text/html" } }
          ),
      });
      const [r] = await extractArticles(["https://news.example/big"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("too_large");
      // It read past the cap by at most a chunk or two of buffering, never the endless stream.
      expect(sent).toBeLessThan(MAX_HTML_BYTES + 4 * chunk.byteLength);
    });

    it("calls a teaser or subscription wall no_content", async () => {
      serve({ "https://news.example/a": html(STUB) });
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("no_content");
    });

    it("decodes the charset the page declares", async () => {
      const latin1 = ARTICLE.replace("The city council voted", "Le conseil a voté");
      const bytes = Uint8Array.from([...latin1].map((c) => c.charCodeAt(0) & 0xff));
      serve({
        "https://news.example/fr": () =>
          new Response(bytes, { headers: { "content-type": "text/html; charset=ISO-8859-1" } }),
      });
      const [r] = await extractArticles(["https://news.example/fr"], { deadline: soon(5_000) });
      expect(r.ok && r.text).toContain("Le conseil a voté");
    });

    it("turns a malformed URL or a network failure into a result, never a throw", async () => {
      serve({
        "https://news.example/a": () => {
          throw new TypeError("fetch failed");
        },
      });
      const results = await extractArticles(["not a url", "ftp://news.example/a", "https://news.example/a"], {
        deadline: soon(5_000),
      });
      expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["error", "error", "error"]);
    });
  });

  describe("the deadline", () => {
    it("answers at the deadline even when a server never responds", async () => {
      serve({ "https://slow.example/a": hang, "https://news.example/b": html(ARTICLE) });
      const started = Date.now();
      const results = await extractArticles(["https://slow.example/a", "https://news.example/b"], {
        deadline: soon(300),
      });
      const took = Date.now() - started;
      expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["timeout", "ok"]);
      expect(took).toBeGreaterThanOrEqual(250);
      // Far under the 8 s page timeout, so the deadline is what ended it, with
      // room for a loaded CI runner.
      expect(took).toBeLessThan(2_500);
    });

    it("answers at the deadline even when a server ignores the abort", async () => {
      serve({ "https://deaf.example/a": () => new Promise<Response>(() => {}) });
      const started = Date.now();
      const [r] = await extractArticles(["https://deaf.example/a"], { deadline: soon(200) });
      expect(r.ok ? "ok" : r.reason).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_500);
    });

    it("times out on a robots.txt that never answers, without blocking past the deadline", async () => {
      serve({ "https://slow.example/robots.txt": hang, "https://slow.example/a": html(ARTICLE) });
      const started = Date.now();
      const [r] = await extractArticles(["https://slow.example/a"], { deadline: soon(200) });
      expect(r.ok ? "ok" : r.reason).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_500);
    });

    it("an already-passed deadline fetches nothing", async () => {
      const { calls } = serve({});
      const results = await extractArticles(["https://news.example/a", "https://news.example/b"], {
        deadline: Date.now() - 1,
      });
      expect(results.every((r) => !r.ok && r.reason === "timeout")).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  describe("the shared concurrency limit", () => {
    it("never has more than MAX_CONCURRENT_PAGES pages in flight, across separate calls", async () => {
      let inFlight = 0;
      let peak = 0;
      const slowPage: Handler = async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
      };
      // robots.txt counts too: it is fetched inside a page's slot.
      const routes: Record<string, Handler> = {
        "https://news.example/robots.txt": async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          return new Response("", { status: 404 });
        },
      };
      const urls = Array.from({ length: 30 }, (_, i) => `https://news.example/${i}`);
      for (const url of urls) routes[url] = slowPage;
      serve(routes);
      // Three callers at once, the way the digest starts every card together.
      const all = await Promise.all([
        extractArticles(urls.slice(0, 10), { deadline: soon(5_000) }),
        extractArticles(urls.slice(10, 20), { deadline: soon(5_000) }),
        extractArticles(urls.slice(20), { deadline: soon(5_000) }),
      ]);
      expect(all.flat().every((r) => r.ok)).toBe(true);
      expect(peak).toBe(MAX_CONCURRENT_PAGES);
    });

    it("frees its slots after a deadline, even from servers that ignore the abort", async () => {
      const hanging: Record<string, Handler> = {};
      for (let i = 0; i < MAX_CONCURRENT_PAGES; i++) {
        hanging[`https://slow.example/${i}`] = i % 2 === 0 ? hang : () => new Promise<Response>(() => {});
      }
      serve({ ...hanging, "https://news.example/after": html(ARTICLE) });
      await extractArticles(Object.keys(hanging), { deadline: soon(100) });
      // The aborted fetches settle on the next turns of the event loop.
      await new Promise((r) => setTimeout(r, 20));
      const [r] = await extractArticles(["https://news.example/after"], { deadline: soon(2_000) });
      expect(r.ok).toBe(true);
    });
  });

  it("logs one summary line per call with counts by outcome, and a broken console can't throw", async () => {
    serve({
      "https://news.example/a": html(ARTICLE),
      "https://news.example/b": () => new Response("", { status: 403 }),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await extractArticles(["https://news.example/a", "https://news.example/b"], { deadline: soon(5_000), label: "card" });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[extract]") && !l.startsWith("[extract] parser thread"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[extract\] card 2 pages: ok=1 http_403=1 in \d+ms rss=\d+MB$/);

    log.mockImplementation(() => {
      throw new Error("stdout closed");
    });
    resetExtractStateForTests();
    await expect(
      extractArticles(["https://news.example/a"], { deadline: soon(5_000) })
    ).resolves.toHaveLength(1);
  });
});

describe("hardening", () => {
  it("treats a host with a trailing dot as the same host: localhost. is refused unrequested", async () => {
    const { calls } = serve({
      "https://news.example/a": () => new Response(null, { status: 302, headers: { location: "http://localhost.:8080/admin" } }),
    });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
    expect(r.ok ? "ok" : r.reason).toBe("error");
    expect(calls.some((c) => c.url.includes("localhost"))).toBe(false);
  });

  it("walks robots.txt redirects by hand and never follows one into a private address", async () => {
    const { calls } = serve({
      "https://news.example/robots.txt": () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/robots.txt" } }),
      "https://news.example/a": html(ARTICLE),
    });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
    // A robots.txt that can't be followed counts as unreachable, which refuses.
    expect(r.ok ? "ok" : r.reason).toBe("robots");
    expect(calls.map((c) => c.url)).toEqual(["https://news.example/robots.txt"]);
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("follows a robots.txt redirect to a public host and obeys the rules it finds there", async () => {
    serve({
      "https://news.example/robots.txt": () =>
        new Response(null, { status: 301, headers: { location: "https://www.news.example/robots.txt" } }),
      "https://www.news.example/robots.txt": () => new Response("User-agent: *\nDisallow: /a\n"),
      "https://news.example/a": html(ARTICLE),
    });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
    expect(r.ok ? "ok" : r.reason).toBe("robots");
  });

  it("reads a <meta charset> when the header names none", async () => {
    const page = ARTICLE.replace('<meta charset="utf-8">', '<meta charset="windows-1252">').replace(
      "The city council voted",
      "Le conseil a voté"
    );
    const bytes = Uint8Array.from([...page].map((c) => c.charCodeAt(0) & 0xff));
    serve({ "https://news.example/fr": () => new Response(bytes, { headers: { "content-type": "text/html" } }) });
    const [r] = await extractArticles(["https://news.example/fr"], { deadline: soon(5_000) });
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });

  it("the header's charset wins over the page's own", async () => {
    const page = ARTICLE.replace('<meta charset="utf-8">', '<meta charset="windows-1252">');
    serve({ "https://news.example/a": html(page.replace("The city council voted", "Le conseil a voté")) });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });

  it.each(["", "   \n  ", "just some words with no markup at all"])("a body with no markup is no_content: %j", async (body) => {
    serve({ "https://news.example/a": html(body) });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
    expect(r.ok ? "ok" : r.reason).toBe("no_content");
  });

  describe("a name that resolves into a private network is never requested", () => {
    it.each([
      ["the metadata address", ["169.254.169.254"]],
      ["loopback", ["127.0.0.1"]],
      ["a private range among public ones", ["93.184.216.34", "10.0.0.5"]],
      ["IPv6 loopback", ["::1"]],
      ["IPv4 written as IPv6", ["::ffff:127.0.0.1"]],
    ])("%s", async (_label, addresses) => {
      mockLookup.mockImplementation(async (host: string) =>
        host === "sneaky.example"
          ? addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
          : [{ address: "93.184.216.34", family: 4 }]
      );
      const { calls } = serve({ "https://news.example/a": () => new Response(null, { status: 302, headers: { location: "https://sneaky.example/x" } }) });
      const results = await extractArticles(["https://sneaky.example/story", "https://news.example/a"], { deadline: soon(5_000) });
      expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["error", "error"]);
      expect(calls.some((c) => c.url.includes("sneaky"))).toBe(false);
    });

    it("refuses a host whose robots.txt name resolves privately, without asking it", async () => {
      mockLookup.mockImplementation(async (host: string) =>
        host === "inside.example" ? [{ address: "192.168.1.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]
      );
      const { calls } = serve({
        "https://news.example/robots.txt": () =>
          new Response(null, { status: 302, headers: { location: "https://inside.example/robots.txt" } }),
        "https://news.example/a": html(ARTICLE),
      });
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("robots");
      expect(calls.map((c) => c.url)).toEqual(["https://news.example/robots.txt"]);
    });

    it("a name that doesn't resolve is an error, with no request", async () => {
      mockLookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
      const { calls } = serve({ "https://nowhere.example/a": html(ARTICLE) });
      const [r] = await extractArticles(["https://nowhere.example/a"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("error");
      expect(calls).toHaveLength(0);
    });

    it("a lookup that hangs ends at the deadline", async () => {
      mockLookup.mockImplementation(() => new Promise(() => {}));
      serve({ "https://slowdns.example/a": html(ARTICLE) });
      const started = Date.now();
      const [r] = await extractArticles(["https://slowdns.example/a"], { deadline: soon(200) });
      expect(r.ok ? "ok" : r.reason).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_500);
    });

    it("looks each name up once for many pages", async () => {
      serve({ "https://news.example/a": html(ARTICLE), "https://news.example/b": html(ARTICLE) });
      await extractArticles(["https://news.example/a", "https://news.example/b"], { deadline: soon(5_000) });
      expect(mockLookup.mock.calls.filter((c) => c[0] === "news.example")).toHaveLength(1);
    });

    it.each(["https://news.example:8443/a", "http://news.example:6379/a", "https://news.example:22/a"])(
      "refuses a port that isn't the web's own: %s",
      async (url) => {
        const { calls } = serve({ [url]: html(ARTICLE) });
        const [r] = await extractArticles([url], { deadline: soon(5_000) });
        expect(r.ok ? "ok" : r.reason).toBe("error");
        expect(calls).toHaveLength(0);
      }
    );

    it("allows the web's own ports written out", async () => {
      serve({ "https://news.example/a": html(ARTICLE), "http://news.example/b": html(ARTICLE) });
      const results = await extractArticles(["https://news.example:443/a", "http://news.example:80/b"], {
        deadline: soon(5_000),
      });
      expect(results.every((r) => r.ok)).toBe(true);
    });
  });

  it.each([429, 503])("after a %i, the host's other pages aren't requested", async (status) => {
    const { pageCalls } = serve({
      "https://busy.example/a": () => new Response("", { status }),
      "https://busy.example/b": html(ARTICLE),
      "https://other.example/c": html(ARTICLE),
    });
    const first = await extractArticles(["https://busy.example/a"], { deadline: soon(5_000) });
    const later = await extractArticles(["https://busy.example/b", "https://other.example/c"], { deadline: soon(5_000) });
    expect(first[0].ok ? "ok" : first[0].reason).toBe(`http_${status}`);
    expect(later.map((r) => (r.ok ? "ok" : r.reason))).toEqual([`http_${status}`, "ok"]);
    expect(pageCalls().map((c) => c.url)).toEqual(["https://busy.example/a", "https://other.example/c"]);
  });

  it("asks a host again once its Retry-After has passed, never sooner than a minute", async () => {
    const { pageCalls } = serve({
      "https://busy.example/a": () => new Response("", { status: 429, headers: { "retry-after": "1" } }),
      "https://busy.example/b": html(ARTICLE),
    });
    await extractArticles(["https://busy.example/a"], { deadline: soon(5_000) });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(now + 30_000);
    const soonAfter = await extractArticles(["https://busy.example/b"], { deadline: now + 35_000 });
    expect(soonAfter[0].ok ? "ok" : soonAfter[0].reason).toBe("http_429");
    clock.mockReturnValue(now + 61_000);
    const [r] = await extractArticles(["https://busy.example/b"], { deadline: now + 66_000 });
    expect(r.ok).toBe(true);
    expect(pageCalls().map((c) => c.url)).toEqual(["https://busy.example/a", "https://busy.example/b"]);
  });

  describe("a resting host isn't asked anything, robots.txt included", () => {
    // These move Date.now forward to reach past the 10-minute caches; every
    // timer the work itself sets still runs on the real clock, with deadlines
    // computed from the faked now.
    function at(ms: number) {
      return vi.spyOn(Date, "now").mockReturnValue(ms);
    }

    it("after a long Retry-After, no robots.txt request once the robots cache has expired", async () => {
      const { calls } = serve({
        "https://news.example/a": () => new Response("", { status: 429, headers: { "retry-after": "3600" } }),
        "https://news.example/b": html(ARTICLE),
      });
      const start = Date.now();
      await extractArticles(["https://news.example/a"], { deadline: start + 5_000 });
      const before = calls.length;
      at(start + 11 * 60_000);
      const [r] = await extractArticles(["https://news.example/b"], { deadline: start + 11 * 60_000 + 5_000 });
      expect(r.ok ? "ok" : r.reason).toBe("http_429");
      expect(calls.slice(before)).toEqual([]);
    });

    it("a 429 on robots.txt itself rests the host for its Retry-After", async () => {
      const { calls } = serve({
        "https://news.example/robots.txt": () => new Response("", { status: 429, headers: { "retry-after": "3600" } }),
        "https://news.example/a": html(ARTICLE),
      });
      const start = Date.now();
      const [first] = await extractArticles(["https://news.example/a"], { deadline: start + 5_000 });
      expect(first.ok ? "ok" : first.reason).toBe("robots");
      at(start + 11 * 60_000);
      const [later] = await extractArticles(["https://news.example/a"], { deadline: start + 11 * 60_000 + 5_000 });
      expect(later.ok).toBe(false);
      expect(calls.map((c) => c.url)).toEqual(["https://news.example/robots.txt"]);
    });

    it("a robots.txt redirect onto a resting host isn't followed", async () => {
      const { calls } = serve({
        "https://busy.example/x": () => new Response("", { status: 403 }),
        "https://news.example/robots.txt": () =>
          new Response(null, { status: 301, headers: { location: "https://busy.example/robots.txt" } }),
        "https://news.example/a": html(ARTICLE),
      });
      await extractArticles(["https://busy.example/x"], { deadline: soon(5_000) });
      const before = calls.length;
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("robots");
      expect(calls.slice(before).map((c) => c.url)).toEqual(["https://news.example/robots.txt"]);
    });

    it("making room among many rests drops expired ones, never a host still resting", async () => {
      const routes: Record<string, Handler> = {
        "https://long.example/a": () => new Response("", { status: 403, headers: { "retry-after": "3600" } }),
        "https://long.example/b": html(ARTICLE),
      };
      const many = Array.from({ length: 499 }, (_, i) => `https://h${i}.example/a`);
      for (const u of many) routes[u] = () => new Response("", { status: 403 });
      routes["https://last.example/a"] = () => new Response("", { status: 403 });
      const { calls } = serve(routes);
      const start = Date.now();
      await extractArticles(["https://long.example/a"], { deadline: start + 5_000 });
      await extractArticles(many, { deadline: start + 20_000 });
      at(start + 11 * 60_000);
      await extractArticles(["https://last.example/a"], { deadline: start + 11 * 60_000 + 5_000 });
      const before = calls.length;
      const [r] = await extractArticles(["https://long.example/b"], { deadline: start + 11 * 60_000 + 5_000 });
      expect(r.ok ? "ok" : r.reason).toBe("http_403");
      expect(calls.slice(before)).toEqual([]);
    });

    it("a failed lookup is retried after half a minute, not ten", async () => {
      mockLookup.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }));
      serve({ "https://flaky.example/a": html(ARTICLE) });
      const start = Date.now();
      const [first] = await extractArticles(["https://flaky.example/a"], { deadline: start + 5_000 });
      expect(first.ok ? "ok" : first.reason).toBe("error");
      at(start + 31_000);
      const [later] = await extractArticles(["https://flaky.example/a"], { deadline: start + 36_000 });
      expect(later.ok).toBe(true);
    });
  });

  it.each([401, 402, 403])("a %i rests the host too: its other pages aren't requested", async (status) => {
    const { pageCalls } = serve({
      "https://news.example/blocked": () => new Response("", { status }),
      "https://news.example/other": html(ARTICLE),
    });
    await extractArticles(["https://news.example/blocked"], { deadline: soon(5_000) });
    const [r] = await extractArticles(["https://news.example/other"], { deadline: soon(5_000) });
    expect(r.ok ? "ok" : r.reason).toBe(`http_${status}`);
    expect(pageCalls()).toHaveLength(1);
  });

  it.each([404, 410, 500])("a %i is about that page only: the host's other pages are still asked", async (status) => {
    const { pageCalls } = serve({
      "https://news.example/gone": () => new Response("", { status }),
      "https://news.example/open": html(ARTICLE),
    });
    await extractArticles(["https://news.example/gone"], { deadline: soon(5_000) });
    const [r] = await extractArticles(["https://news.example/open"], { deadline: soon(5_000) });
    expect(r.ok).toBe(true);
    expect(pageCalls()).toHaveLength(2);
  });

  it("a story's fallback doesn't go back to a host that just refused it", async () => {
    const story = [
      "https://busy.example/first",
      "https://b.example/1",
      "https://c.example/1",
      "https://busy.example/second",
      "https://d.example/1",
    ];
    const { pageCalls } = serve({
      [story[0]]: () => new Response("", { status: 403 }),
      [story[1]]: html(ARTICLE),
      [story[2]]: html(ARTICLE),
      [story[3]]: html(ARTICLE),
      [story[4]]: html(ARTICLE),
    });
    const results = await extractForStory(story, { deadline: soon(5_000) });
    expect(pageCalls().map((c) => c.url)).toEqual([story[0], story[1], story[2], story[4]]);
    expect(results.map((r) => (r?.ok ? "ok" : r?.reason))).toEqual(["http_403", "ok", "ok", "http_403", "ok"]);
  });

  it("logs one line per story, however many rounds it took", async () => {
    serve({
      "https://a.example/1": () => new Response("", { status: 404 }),
      "https://b.example/1": html(ARTICLE),
      "https://c.example/1": html(ARTICLE),
      "https://d.example/1": html(ARTICLE),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await extractForStory(["https://a.example/1", "https://b.example/1", "https://c.example/1", "https://d.example/1"], {
      deadline: soon(5_000),
      label: "writeCard",
    });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[extract]") && !l.startsWith("[extract] parser thread"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[extract\] writeCard 4 pages: http_404=1 ok=3 in \d+ms/);
  });

  it("reads a <meta charset=utf-16> page as UTF-8, as browsers do", async () => {
    const page = ARTICLE.replace('<meta charset="utf-8">', '<meta charset="utf-16">').replace("The city council voted", "Le conseil a voté");
    serve({ "https://news.example/a": () => new Response(new TextEncoder().encode(page), { headers: { "content-type": "text/html" } }) });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });

  describe("pages built to make the parse slow are refused before it runs long", () => {
    const para = "<p>" + "Words in a sentence that goes on. ".repeat(10) + "</p>";
    const wrap = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

    it.each([
      ["1,000 nested divs, a 12 KB page", wrap("<div>".repeat(1_000) + para + "</div>".repeat(1_000))],
      ["5,000 nested divs", wrap("<div>".repeat(5_000) + para + "</div>".repeat(5_000))],
      ["30,000 unclosed tags", wrap("<i>".repeat(30_000) + para)],
      ["30,000 flat tags", wrap("<span>x</span>".repeat(30_000))],
    ])("%s: too_large, quickly", async (_label, page) => {
      serve({ "https://evil.example/a": html(page) });
      const started = Date.now();
      const [r] = await extractArticles(["https://evil.example/a"], { deadline: soon(5_000) });
      expect(r.ok ? "ok" : r.reason).toBe("too_large");
      // Unguarded, the first two run for seconds to minutes.
      expect(Date.now() - started).toBeLessThan(1_500);
    });

    it("a page nested 60 deep still extracts", async () => {
      const page = ARTICLE.replace("<main>", "<main>" + "<div>".repeat(40)).replace("</main>", "</div>".repeat(40) + "</main>");
      serve({ "https://news.example/a": html(page) });
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(5_000) });
      expect(r.ok).toBe(true);
    });
  });

  it("tells the writer to use its own words", () => {
    expect(FULL_TEXT_INSTRUCTION).toContain("never copy sentences from the articles");
  });
});

describe("extractForStory", () => {
  const urls = Array.from({ length: 7 }, (_, i) => `https://s${i}.example/story`);
  const routesWith = (blocked: number[]) => {
    const routes: Record<string, Handler> = {};
    urls.forEach((u, i) => {
      routes[u] = blocked.includes(i) ? () => new Response("", { status: 403 }) : html(ARTICLE);
    });
    return routes;
  };

  it(`fetches only the first ${MAX_FULL_TEXTS_PER_STORY} pages when they all load`, async () => {
    const { pageCalls } = serve(routesWith([]));
    const results = await extractForStory(urls, { deadline: soon(5_000) });
    expect(pageCalls().map((c) => c.url)).toEqual(urls.slice(0, MAX_FULL_TEXTS_PER_STORY));
    expect(results).toHaveLength(MAX_FULL_TEXTS_PER_STORY);
    expect(results.every((r) => r?.ok)).toBe(true);
  });

  it("reaches one page further down for each page that failed, in order", async () => {
    const { pageCalls } = serve(routesWith([0, 2]));
    const results = await extractForStory(urls, { deadline: soon(5_000) });
    expect(pageCalls().map((c) => c.url)).toEqual(urls.slice(0, 5));
    expect(results.map((r) => (r?.ok ? "ok" : r?.reason))).toEqual(["http_403", "ok", "http_403", "ok", "ok"]);
  });

  it(`never tries more than ${MAX_PAGES_PER_STORY} pages`, async () => {
    const { pageCalls } = serve(routesWith([0, 1, 2, 3, 4, 5, 6]));
    const results = await extractForStory(urls, { deadline: soon(5_000) });
    expect(pageCalls()).toHaveLength(MAX_PAGES_PER_STORY);
    expect(results).toHaveLength(MAX_PAGES_PER_STORY);
    expect(results.some((r) => r?.ok)).toBe(false);
  });

  it("stops at the deadline: no fallback round once time is up", async () => {
    const routes = routesWith([]);
    for (const u of urls.slice(0, 3)) routes[u] = hang;
    const { pageCalls } = serve(routes);
    const started = Date.now();
    const results = await extractForStory(urls, { deadline: soon(200) });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(results.map((r) => (r?.ok ? "ok" : r?.reason))).toEqual(["timeout", "timeout", "timeout"]);
    expect(pageCalls().map((c) => c.url)).toEqual(urls.slice(0, 3));
  });

  it("handles a story with fewer pages than the cap, and none at all", async () => {
    serve(routesWith([0]));
    expect((await extractForStory(urls.slice(0, 2), { deadline: soon(5_000) })).map((r) => r?.ok)).toEqual([false, true]);
    expect(await extractForStory([], { deadline: soon(5_000) })).toEqual([]);
  });
});

describe("clipText", () => {
  it("leaves short text alone", () => {
    expect(clipText("One. Two.", 100)).toBe("One. Two.");
  });

  it("ends on a sentence when one ends late enough in the window", () => {
    const text = "A".repeat(80) + ". Next sentence runs on and on.";
    expect(clipText(text, 100)).toBe("A".repeat(80) + ".");
  });

  it("otherwise ends on a word", () => {
    const text = "Short. " + "word ".repeat(40);
    const clipped = clipText(text, 100);
    expect(clipped.length).toBeLessThanOrEqual(100);
    expect(clipped.endsWith("word")).toBe(true);
  });

  it("defaults to MAX_TEXT_CHARS", () => {
    expect(clipText("x ".repeat(2000)).length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });
});

describe("robotsAllows", () => {
  const rules = "User-agent: *\nDisallow: /private\nAllow: /private/ok$\nDisallow: /*.pdf$\n";
  it.each([
    ["/news/a", true],
    ["/private/x", false],
    ["/private/ok", true],
    ["/private/ok/more", false],
    ["/doc.pdf", false],
    ["/doc.pdf?x=1", true],
  ])("%s → %s", (p, allowed) => {
    expect(robotsAllows(rules, "H72NewsAggregator", p)).toBe(allowed);
  });

  it.each([
    ["User-agent: *\nDisallow: /café\n", "/caf%C3%A9/story"],
    ["User-agent: *\nDisallow: /caf%c3%a9\n", "/caf%C3%A9/story"],
    ["User-agent: *\nDisallow: /caf%C3%A9\n", "/caf%c3%a9/story"],
    ["User-agent: *\nDisallow: /أخبار\n", new URL("https://x.example/أخبار/1").pathname],
  ])("compares rules and paths percent-encoded: %j blocks %s", (txt, p) => {
    expect(robotsAllows(txt, "H72NewsAggregator", p)).toBe(false);
  });

  it.each([
    ["Disallow: /{draft}", "/%7Bdraft%7D/1"],
    ["Disallow: /~staff", "/%7Estaff/page"],
    ["Disallow: /%7Estaff", "/~staff/page"],
    ['Disallow: /say "hi"', "/say%20%22hi%22"],
  ])("normalises escapes both ways: %s blocks %s", (rule, p) => {
    expect(robotsAllows(`User-agent: *\n${rule}\n`, "H72NewsAggregator", p)).toBe(false);
  });

  it.each([
    ["/a*b$", "/axxb", true],
    ["/a*b$", "/axxbc", false],
    ["/a*b", "/axxbc", true],
    ["/a**b", "/ab", true],
    ["/*.php$", "/index.php", true],
    ["/*.php$", "/index.php5", false],
    ["/x*y*z", "/xzy", false],
    ["/p$", "/p", true],
    ["/p$", "/pq", false],
  ])("wildcards: Disallow %s on %s matches = %s", (rule, p, matches) => {
    expect(robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, "H72NewsAggregator", p)).toBe(!matches);
  });

  it("matches a pathological wildcard rule in linear time", () => {
    const started = Date.now();
    const allowed = robotsAllows(
      "User-agent: *\nDisallow: /*a*a*a*a*a*a*a*a*a*a*a*a*b\n",
      "H72NewsAggregator",
      "/" + "a".repeat(5_000)
    );
    expect(allowed).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("never requests a page whose non-ASCII path a robots rule disallows", async () => {
    const { pageCalls } = serve({
      "https://news.example/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /actualité\n", { headers: { "content-type": "text/plain; charset=utf-8" } }),
    });
    const [r] = await extractArticles(["https://news.example/actualité/story"], { deadline: soon(5_000) });
    expect(r.ok ? "ok" : r.reason).toBe("robots");
    expect(pageCalls()).toHaveLength(0);
  });
});
