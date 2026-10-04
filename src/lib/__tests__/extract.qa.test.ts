import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Names resolve to a public address without a real DNS query; tests about
// private resolution live in extract.test.ts.
vi.mock("node:dns/promises", () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  return { lookup, default: { lookup } };
});
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  clipText,
  extractArticles,
  MAX_CONCURRENT_PAGES,
  MAX_HTML_BYTES,
  MAX_TEXT_CHARS,
  resetExtractStateForTests,
  robotsAllows,
} from "@/lib/extract";

// Edge cases and slot-leak checks beyond extract.test.ts. Every
// request goes to a fake web; an unknown URL fails the test, so nothing here
// can reach the network.

const ARTICLE = readFileSync(path.join(__dirname, "fixtures/extract/article.html"), "utf8");

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
  return { calls, pageCalls: () => calls.filter((c) => !c.url.endsWith("/robots.txt")) };
}

const html = (body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) => () =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

const hang: Handler = ({ init }) =>
  new Promise<Response>((_, reject) => {
    const signal = init.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
const deaf: Handler = () => new Promise<Response>(() => {});

const soon = (ms: number) => Date.now() + ms;
const reasons = (rs: { ok: boolean; reason?: string }[]) => rs.map((r) => (r.ok ? "ok" : r.reason));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Proves every one of the MAX_CONCURRENT_PAGES slots is free: starts that many
 * slow pages at once and requires all of them in flight together. A single
 * leaked slot makes the peak one lower.
 */
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
  expect(reasons(results).every((r) => r === "ok")).toBe(true);
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

describe("blocked stays blocked, on redirect hops", () => {
  it("asks robots.txt again for a same-host redirect, and never requests the disallowed hop", async () => {
    const { calls } = serve({
      "https://news.example/robots.txt": () => new Response("User-agent: *\nDisallow: /members\n"),
      "https://news.example/a": () => new Response(null, { status: 302, headers: { location: "/members/a" } }),
      "https://news.example/members/a": html(ARTICLE),
    });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
    expect(r.ok ? "ok" : r.reason).toBe("robots");
    expect(calls.map((c) => c.url)).not.toContain("https://news.example/members/a");
  });

  it("refuses when a later hop's robots.txt is unreachable (503, 429, network failure)", async () => {
    for (const robots of [
      () => new Response("", { status: 503 }),
      () => new Response("", { status: 429 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ] as Handler[]) {
      resetExtractStateForTests();
      const { calls } = serve({
        "https://short.example/x": () => new Response(null, { status: 301, headers: { location: "https://far.example/s" } }),
        "https://far.example/robots.txt": robots,
        "https://far.example/s": html(ARTICLE),
      });
      const [r] = await extractArticles(["https://short.example/x"], { deadline: soon(3_000) });
      expect(r.ok ? "ok" : r.reason).toBe("robots");
      expect(calls.map((c) => c.url)).not.toContain("https://far.example/s");
    }
  });

  it.each([401, 402, 403, 429, 500, 502])("a %i at the end of a redirect is final: each URL requested once", async (status) => {
    const { pageCalls } = serve({
      "https://short.example/x": () => new Response(null, { status: 302, headers: { location: "https://far.example/s" } }),
      "https://far.example/s": () => new Response("no", { status }),
    });
    const [r] = await extractArticles(["https://short.example/x"], { deadline: soon(3_000) });
    expect(r).toEqual({ url: "https://short.example/x", ok: false, reason: `http_${status}` });
    expect(pageCalls().map((c) => c.url)).toEqual(["https://short.example/x", "https://far.example/s"]);
  });

  it("follows five redirects and refuses the sixth", async () => {
    const chain = (n: number) => {
      const routes: Record<string, Handler> = {};
      for (let i = 0; i < n; i++) {
        routes[`https://r.example/${i}`] = () => new Response(null, { status: 302, headers: { location: `/${i + 1}` } });
      }
      routes[`https://r.example/${n}`] = html(ARTICLE);
      return routes;
    };
    serve(chain(5));
    expect(reasons(await extractArticles(["https://r.example/0"], { deadline: soon(3_000) }))).toEqual(["ok"]);
    resetExtractStateForTests();
    const { pageCalls } = serve(chain(6));
    expect(reasons(await extractArticles(["https://r.example/0"], { deadline: soon(3_000) }))).toEqual(["error"]);
    expect(pageCalls()).toHaveLength(6);
  });

  it("a 3xx with no Location is an http_ result, not a loop", async () => {
    serve({ "https://news.example/a": () => new Response(null, { status: 304 }) });
    expect(reasons(await extractArticles(["https://news.example/a"], { deadline: soon(3_000) }))).toEqual(["http_304"]);
  });

  it("an unparsable Location is an error, with no further request", async () => {
    const { calls } = serve({
      "https://news.example/a": () => new Response(null, { status: 302, headers: { location: "http://[bad" } }),
    });
    expect(reasons(await extractArticles(["https://news.example/a"], { deadline: soon(3_000) }))).toEqual(["error"]);
    expect(calls).toHaveLength(2);
  });

  it("a robots.txt answering 4xx (including 401/403) means no rules, per RFC 9309; the page's own refusal still stands", async () => {
    const { pageCalls } = serve({
      "https://news.example/robots.txt": () => new Response("", { status: 403 }),
      "https://news.example/a": () => new Response("", { status: 403 }),
    });
    expect(reasons(await extractArticles(["https://news.example/a"], { deadline: soon(3_000) }))).toEqual(["http_403"]);
    expect(pageCalls()).toHaveLength(1);
  });
});

describe("addresses that must never be requested", () => {
  it.each([
    "http://127.0.0.1/a",
    "http://2130706433/a", // 127.0.0.1 as one decimal number
    "http://0x7f.1/a",
    "http://localhost/a",
    "http://10.0.0.5/a",
    "http://192.168.1.1/a",
    "http://172.16.0.1/a",
    "http://169.254.169.254/latest",
    "http://0.0.0.0/a",
    "http://[::1]/a",
    "http://[::ffff:127.0.0.1]/a",
    "http://[fe80::1]/a",
    "http://[fd00::1]/a",
    "file:///etc/passwd",
    "data:text/html,<p>x</p>",
    "javascript:alert(1)",
  ])("%s, as the first URL or as a redirect target, is an error with no request", async (target) => {
    const { calls } = serve({
      "https://news.example/a": () => new Response(null, { status: 302, headers: { location: target } }),
    });
    const results = await extractArticles([target, "https://news.example/a"], { deadline: soon(3_000) });
    expect(reasons(results)).toEqual(["error", "error"]);
    expect(calls.map((c) => c.url)).toEqual(["https://news.example/robots.txt", "https://news.example/a"]);
  });
});

describe("content edge cases", () => {
  it("a page whose text is all whitespace is no_content", async () => {
    serve({
      "https://news.example/blank": html(`<html><body><article>${" \n\t ".repeat(500)}<p>   </p></article></body></html>`),
      "https://news.example/empty": html(""),
    });
    const results = await extractArticles(["https://news.example/blank", "https://news.example/empty"], {
      deadline: soon(3_000),
    });
    expect(results[0]).toEqual({ url: "https://news.example/blank", ok: false, reason: "no_content" });
    // A tagless body makes linkedom return no document, so Readability throws
    // and the reason is "error" rather than "no_content". Either way: no text.
    expect(results[1].ok).toBe(false);
  });

  it("a body of exactly MAX_HTML_BYTES is read; one byte more is too_large", async () => {
    const page = (size: number) => {
      const head = new TextEncoder().encode(ARTICLE.replace("</body></html>", ""));
      const out = new Uint8Array(size).fill(0x20);
      out.set(head, 0);
      return out;
    };
    serve({
      "https://news.example/max": html(page(MAX_HTML_BYTES)),
      "https://news.example/over": html(page(MAX_HTML_BYTES + 1)),
    });
    const results = await extractArticles(["https://news.example/max", "https://news.example/over"], {
      deadline: soon(5_000),
    });
    expect(reasons(results)).toEqual(["ok", "too_large"]);
  });

  it("a page with more than 20,000 elements is refused, not parsed by Readability", async () => {
    serve({ "https://news.example/bomb": html(`<html><body>${"<span>x</span>".repeat(20_001)}</body></html>`) });
    expect(reasons(await extractArticles(["https://news.example/bomb"], { deadline: soon(5_000) }))).toEqual([
      "too_large",
    ]);
  });

  it("an unknown charset label falls back to UTF-8 rather than failing", async () => {
    serve({ "https://news.example/a": html(ARTICLE, { "content-type": "text/html; charset=x-made-up" }) });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
    expect(r.ok && r.text).toContain("The city council voted");
  });

  it("decodes a Shift_JIS page by its header", async () => {
    // "日本" in Shift_JIS is 93 FA 96 7B.
    const prefix = new TextEncoder().encode(ARTICLE.replace("The city council voted", "XXXXThe city council voted"));
    const at = new TextDecoder().decode(prefix).indexOf("XXXX");
    const bytes = new Uint8Array(prefix);
    bytes.set([0x93, 0xfa, 0x96, 0x7b], at);
    serve({ "https://news.example/jp": html(bytes, { "content-type": "text/html; charset=Shift_JIS" }) });
    const [r] = await extractArticles(["https://news.example/jp"], { deadline: soon(3_000) });
    expect(r.ok && r.text).toContain("日本The city council voted");
  });

  it("duplicate URLs each get a result in order (the page is requested once per copy, robots.txt once)", async () => {
    const { calls } = serve({ "https://news.example/a": html(ARTICLE) });
    const results = await extractArticles(["https://news.example/a", "https://news.example/a"], {
      deadline: soon(3_000),
    });
    expect(reasons(results)).toEqual(["ok", "ok"]);
    expect(calls.filter((c) => c.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("an empty URL list returns [] without a request", async () => {
    const { calls } = serve({});
    await expect(extractArticles([], { deadline: soon(1_000) })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("the deadline and the shared slots", () => {
  it("a robots.txt that ignores its abort is cached as pending: later pages on that host time out at their own deadline", async () => {
    serve({ "https://deaf.example/robots.txt": deaf, "https://deaf.example/a": html(ARTICLE) });
    const t0 = Date.now();
    expect(reasons(await extractArticles(["https://deaf.example/a"], { deadline: soon(150) }))).toEqual(["timeout"]);
    expect(reasons(await extractArticles(["https://deaf.example/a"], { deadline: soon(150) }))).toEqual(["timeout"]);
    expect(Date.now() - t0).toBeLessThan(900);
    await sleep(20);
    await expectAllSlotsFree();
  });

  it("every slot is free again after concurrent callers hit hanging, deaf, slow-body and failing servers", async () => {
    const routes: Record<string, Handler> = {};
    const urls: string[] = [];
    for (let i = 0; i < 24; i++) {
      const url = `https://mix${i % 6}.example/${i}`;
      urls.push(url);
      routes[url] = [
        hang,
        deaf,
        // headers arrive, the body never finishes and ignores cancel
        () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/html" } }),
        () => new Response("", { status: 403 }),
        () => {
          throw new TypeError("fetch failed");
        },
        html(ARTICLE),
      ][i % 6];
    }
    serve(routes);
    const t0 = Date.now();
    const all = await Promise.all([
      extractArticles(urls.slice(0, 8), { deadline: soon(150) }),
      extractArticles(urls.slice(8, 16), { deadline: soon(200) }),
      extractArticles(urls.slice(16), { deadline: soon(250) }),
    ]);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(all.flat()).toHaveLength(24);
    await sleep(30);
    await expectAllSlotsFree();
  });

  it("a caller queued behind full slots answers at its own deadline, and its stale place in the queue doesn't leak a slot", async () => {
    const routes: Record<string, Handler> = {};
    const busy = Array.from({ length: MAX_CONCURRENT_PAGES }, (_, i) => `https://busy.example/${i}`);
    for (const url of busy) {
      routes[url] = async () => {
        await sleep(300);
        return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
      };
    }
    routes["https://queued.example/a"] = html(ARTICLE);
    serve(routes);
    const first = extractArticles(busy, { deadline: soon(3_000) });
    await sleep(10);
    const t0 = Date.now();
    const queued = await extractArticles(["https://queued.example/a"], { deadline: soon(80) });
    expect(reasons(queued)).toEqual(["timeout"]);
    expect(Date.now() - t0).toBeLessThan(250);
    expect(reasons(await first).every((r) => r === "ok")).toBe(true);
    await expectAllSlotsFree();
  });

  it("a page whose download finishes after the deadline is not parsed and is reported as a timeout", async () => {
    serve({
      "https://late.example/a": async () => {
        await sleep(120);
        return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
      },
    });
    const [r] = await extractArticles(["https://late.example/a"], { deadline: soon(100) });
    expect(r.ok ? "ok" : r.reason).toBe("timeout");
  });

  it("a download that completes just as the deadline passes is not parsed", async () => {
    // The clock jumps past the deadline while the response arrives; the abort
    // timer (real time) has not fired, so only the post-download check can
    // catch it.
    const realNow = Date.now;
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    serve({
      "https://edge.example/a": () => {
        offset = 10_000;
        return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
      },
    });
    const [r] = await extractArticles(["https://edge.example/a"], { deadline: realNow() + 2_000 });
    expect(r.ok ? "ok" : r.reason).toBe("timeout");
  });

  it("no unhandled rejection escapes from aborted or late-failing fetches", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      serve({
        "https://h.example/a": hang,
        "https://late.example/a": async () => {
          await sleep(150);
          throw new TypeError("fetch failed late");
        },
      });
      await extractArticles(["https://h.example/a", "https://late.example/a"], { deadline: soon(80) });
      await sleep(200);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("clipText boundaries", () => {
  it("text of exactly max is untouched; max+1 is cut", () => {
    const exact = "word ".repeat(20).trim(); // 99 chars
    expect(clipText(exact + "s", 100)).toBe(exact + "s");
    expect(clipText(exact + "s.", 100).length).toBeLessThanOrEqual(100);
  });

  it("text with no spaces and no sentence end (e.g. CJK) is still cut to max", () => {
    const cjk = "日本語の文章".repeat(400);
    const out = clipText(cjk, MAX_TEXT_CHARS);
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(out.length).toBeGreaterThan(0);
  });

  it("the sentence floor is two thirds of the window: an earlier sentence end gives way to a word cut", () => {
    const text = "Early end. " + "word ".repeat(40);
    const out = clipText(text, 100);
    expect(out.startsWith("Early end. word")).toBe(true);
    expect(out.endsWith("word")).toBe(true);
  });

  it("closing quotes after a full stop stay with the sentence", () => {
    const text = "x".repeat(70) + ' he said."' + " More text follows here and keeps on going well past the limit.";
    expect(clipText(text, 100)).toBe("x".repeat(70) + ' he said."');
  });
});

describe("robots matching details", () => {
  it("matches the agent group case-insensitively and with a version suffix", () => {
    expect(robotsAllows("User-agent: h72newsaggregator/0.1\nDisallow: /\n", "H72NewsAggregator", "/a")).toBe(false);
  });

  it("Allow wins a same-length tie, and the longest rule wins otherwise", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a\n", "H72NewsAggregator", "/a/b")).toBe(true);
    expect(robotsAllows("User-agent: *\nAllow: /a\nDisallow: /a/b\n", "H72NewsAggregator", "/a/b/c")).toBe(false);
  });
});
