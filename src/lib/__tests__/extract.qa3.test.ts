import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// QA round 3. No real DNS: every lookup goes through mockLookup. No real web:
// every request goes to a fake web, and an unknown URL fails the test.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  extractArticles,
  extractForStory,
  resetExtractStateForTests,
  robotsAllows,
  type ExtractResult,
} from "@/lib/extract";

const ARTICLE = readFileSync(path.join(__dirname, "fixtures/extract/article.html"), "utf8");
const TOKEN = "H72NewsAggregator";
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

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
  return {
    calls,
    urls: () => calls.map((c) => c.url),
    pageCalls: () => calls.filter((c) => !c.url.endsWith("/robots.txt")).map((c) => c.url),
  };
}

const page = (body: string | Uint8Array<ArrayBuffer> = ARTICLE, type = "text/html; charset=utf-8") => () =>
  new Response(body, { status: 200, headers: { "content-type": type } });
const status = (code: number, headers: Record<string, string> = {}) => () => new Response("", { status: code, headers });
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const outcome = (r: ExtractResult | undefined) => (r === undefined ? "untried" : r.ok ? "ok" : r.reason);
const soon = (ms: number) => Date.now() + ms;

/** Freezes Date.now at real-now + offset; the offset can be moved. Real timers keep running. */
function clock() {
  const realNow = Date.now;
  const base = realNow();
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() - base + base + offset);
  return { at: (ms: number) => (offset = ms), now: () => Date.now() };
}

beforeEach(() => {
  resetExtractStateForTests();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue(PUBLIC);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- 1. the resolution check ---------------------------------------------------

describe("resolution check: addresses a name may resolve to", () => {
  async function tryWith(addresses: { address: string; family: number }[]) {
    mockLookup.mockImplementation(async (host: string) => (host === "target.example" ? addresses : PUBLIC));
    const { calls } = serve({ "https://target.example/a": page() });
    const [r] = await extractArticles(["https://target.example/a"], { deadline: soon(3_000) });
    return { r: outcome(r), requested: calls.map((c) => c.url) };
  }

  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.2",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "::FFFF:A9FE:A9FE",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%lo0",
    "febf::1",
    "ff02::1",
  ])("%s is refused, with no request at all", async (address) => {
    const { r, requested } = await tryWith([{ address, family: address.includes(":") ? 6 : 4 }]);
    expect(r).toBe("error");
    expect(requested).toEqual([]);
  });

  // Forms that embed a private IPv4 address in IPv6 that the classifier may not know.
  it.each([
    ["IPv4-compatible ::127.0.0.1", "::7f00:1"],
    ["IPv4-compatible ::169.254.169.254", "::a9fe:a9fe"],
    ["IPv4-translated ::ffff:0:127.0.0.1", "::ffff:0:7f00:1"],
    ["NAT64 64:ff9b::169.254.169.254", "64:ff9b::a9fe:a9fe"],
    ["6to4 2002:a9fe:a9fe:: (169.254.169.254)", "2002:a9fe:a9fe::1"],
    ["deprecated site-local fec0::1", "fec0::1"],
    ["uncompressed loopback 0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:1"],
    ["loopback with a zone ::1%lo0", "::1%lo0"],
  ])("%s is refused", async (_label, address) => {
    const { r, requested } = await tryWith([{ address, family: 6 }]);
    expect(r).toBe("error");
    expect(requested).toEqual([]);
  });

  it.each(["93.184.216.34", "172.32.0.1", "172.15.255.255", "100.63.255.255", "100.128.0.1", "198.20.0.1", "192.169.0.1", "223.255.255.255", "2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888"])(
    "public %s is allowed",
    async (address) => {
      const { r } = await tryWith([{ address, family: address.includes(":") ? 6 : 4 }]);
      expect(r).toBe("ok");
    }
  );

  it("an empty address list refuses, with no request", async () => {
    const { r, requested } = await tryWith([]);
    expect(r).toBe("error");
    expect(requested).toEqual([]);
  });

  it("a lookup resolving to a non-array (undefined) refuses rather than throwing out", async () => {
    mockLookup.mockResolvedValue(undefined);
    const { calls } = serve({ "https://target.example/a": page() });
    const [r] = await extractArticles(["https://target.example/a"], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("error");
    expect(calls).toEqual([]);
  });

  it("asks for every address (all: true), not just the first", async () => {
    await tryWith(PUBLIC);
    const call = mockLookup.mock.calls.find((c) => c[0] === "target.example");
    expect(call?.[1]).toMatchObject({ all: true });
  });

  it("one private address among public ones, last in the list, refuses", async () => {
    const { r, requested } = await tryWith([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
      { address: "::ffff:10.0.0.1", family: 6 },
    ]);
    expect(r).toBe("error");
    expect(requested).toEqual([]);
  });

  it("looks up the bare name: brackets and trailing dots stripped, case folded", async () => {
    serve({ "https://news.example./a": page() });
    await extractArticles(["https://NEWS.example./a"], { deadline: soon(3_000) });
    expect(mockLookup.mock.calls.map((c) => c[0])).toEqual(["news.example"]);
  });

  it("an IP literal is never looked up", async () => {
    serve({ "http://93.184.216.34/a": page() });
    const [r] = await extractArticles(["http://93.184.216.34/a"], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("ok");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("one lookup per name across http and https and across stories", async () => {
    serve({ "https://news.example/a": page(), "http://news.example/b": page() });
    await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
    await extractForStory(["http://news.example/b"], { deadline: soon(3_000) });
    expect(mockLookup.mock.calls.filter((c) => c[0] === "news.example")).toHaveLength(1);
  });

  it("the lookup is refreshed after 10 minutes: a name that has since turned private is refused", async () => {
    const t = clock();
    let answer = PUBLIC;
    mockLookup.mockImplementation(async () => answer);
    const { pageCalls } = serve({ "https://flip.example/a": page(), "https://flip.example/b": page() });
    const [first] = await extractArticles(["https://flip.example/a"], { deadline: t.now() + 3_000 });
    expect(outcome(first)).toBe("ok");
    answer = [{ address: "169.254.169.254", family: 4 }];
    t.at(9 * 60_000);
    // Still within the cache: the old (public) answer stands.
    expect(mockLookup).toHaveBeenCalledTimes(1);
    t.at(10 * 60_000 + 1);
    const [later] = await extractArticles(["https://flip.example/b"], { deadline: t.now() + 3_000 });
    expect(outcome(later)).toBe("error");
    expect(pageCalls()).toEqual(["https://flip.example/a"]);
  });

  it("a redirect hop to a name resolving privately is refused before its robots.txt or page is asked", async () => {
    mockLookup.mockImplementation(async (host: string) =>
      host === "inner.example" ? [{ address: "10.0.0.7", family: 4 }] : PUBLIC
    );
    const { urls } = serve({ "https://news.example/a": redirect("https://inner.example/x") });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("error");
    expect(urls()).toEqual(["https://news.example/robots.txt", "https://news.example/a"]);
  });

  it("a robots.txt redirect to a non-web port refuses the host as robots, unrequested", async () => {
    const { urls } = serve({
      "https://news.example/robots.txt": redirect("https://news.example:6379/robots.txt"),
      "https://news.example/a": page(),
    });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("robots");
    expect(urls()).toEqual(["https://news.example/robots.txt"]);
  });

  it("a lookup that rejects on a robots.txt hop refuses the host as robots", async () => {
    mockLookup.mockImplementation(async (host: string) => {
      if (host === "gone.example") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return PUBLIC;
    });
    const { urls } = serve({
      "https://news.example/robots.txt": redirect("https://gone.example/robots.txt"),
      "https://news.example/a": page(),
    });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("robots");
    expect(urls()).toEqual(["https://news.example/robots.txt"]);
  });

  it("hanging lookups on many hosts end at the deadline and leave every slot free", async () => {
    mockLookup.mockImplementation((host: string) => (host.startsWith("deaf") ? new Promise(() => {}) : Promise.resolve(PUBLIC)));
    const deafUrls = Array.from({ length: 12 }, (_, i) => `https://deaf${i}.example/a`);
    serve({});
    const started = Date.now();
    const results = await extractArticles(deafUrls, { deadline: soon(300) });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(results.every((r) => outcome(r) === "timeout")).toBe(true);
    // Slots are free: eight fresh pages run at once.
    let inFlight = 0;
    let peak = 0;
    const routes: Record<string, Handler> = {};
    const probe = Array.from({ length: 8 }, (_, i) => `https://probe${i}.example/a`);
    for (const u of probe) {
      routes[u] = async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return new Response(ARTICLE, { headers: { "content-type": "text/html" } });
      };
    }
    serve(routes);
    const ok = await extractArticles(probe, { deadline: soon(3_000) });
    expect(ok.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(8);
  });
});

// --- 4. hosts that refuse rest -------------------------------------------------

describe("hosts that refuse rest", () => {
  it("a resting origin's robots.txt isn't requested either, even after the robots cache expires", async () => {
    const t = clock();
    const { urls } = serve({
      "https://busy.example/a": status(429, { "retry-after": "3600" }),
      "https://busy.example/b": page(),
    });
    await extractArticles(["https://busy.example/a"], { deadline: t.now() + 3_000 });
    expect(urls()).toEqual(["https://busy.example/robots.txt", "https://busy.example/a"]);
    t.at(11 * 60_000); // robots cache (10 min) expired, Retry-After (1 h) not
    const [r] = await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 });
    expect(outcome(r)).toBe("http_429");
    // Nothing more sent to the origin that asked for an hour's rest.
    expect(urls()).toEqual(["https://busy.example/robots.txt", "https://busy.example/a"]);
  });

  it("a robots.txt that answers 429 with Retry-After: 3600 isn't asked again after 11 minutes", async () => {
    const t = clock();
    const { urls } = serve({
      "https://busy.example/robots.txt": status(429, { "retry-after": "3600" }),
      "https://busy.example/a": page(),
      "https://busy.example/b": page(),
    });
    expect(outcome((await extractArticles(["https://busy.example/a"], { deadline: t.now() + 3_000 }))[0])).toBe("robots");
    t.at(11 * 60_000);
    expect(outcome((await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 }))[0])).toBe("http_429");
    expect(urls()).toEqual(["https://busy.example/robots.txt"]);
  });

  it("an HTTP-date Retry-After is honoured", async () => {
    const t = clock();
    const until = new Date(t.now() + 5 * 60_000).toUTCString();
    const { pageCalls } = serve({
      "https://busy.example/a": status(503, { "retry-after": until }),
      "https://busy.example/b": page(),
    });
    await extractArticles(["https://busy.example/a"], { deadline: t.now() + 3_000 });
    t.at(4 * 60_000);
    expect(outcome((await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 }))[0])).toBe("http_503");
    t.at(6 * 60_000);
    expect(outcome((await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 }))[0])).toBe("ok");
    expect(pageCalls()).toEqual(["https://busy.example/a", "https://busy.example/b"]);
  });

  it("a Retry-After over an hour is capped at an hour", async () => {
    const t = clock();
    const { pageCalls } = serve({
      "https://busy.example/a": status(429, { "retry-after": "86400" }),
      "https://busy.example/b": page(),
    });
    await extractArticles(["https://busy.example/a"], { deadline: t.now() + 3_000 });
    t.at(59 * 60_000);
    expect(outcome((await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 }))[0])).toBe("http_429");
    t.at(61 * 60_000);
    expect(outcome((await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 }))[0])).toBe("ok");
    expect(pageCalls()).toEqual(["https://busy.example/a", "https://busy.example/b"]);
  });

  it.each(["soon", "", "-30", "0"])("Retry-After %j: no shorter than the minute floor, default 10 min when unparseable", async (value) => {
    const t = clock();
    const { pageCalls } = serve({
      "https://busy.example/a": status(403, value === "" ? {} : { "retry-after": value }),
      "https://busy.example/b": page(),
    });
    await extractArticles(["https://busy.example/a"], { deadline: t.now() + 3_000 });
    t.at(59_000);
    expect(outcome((await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 }))[0])).toBe("http_403");
    const numeric = value === "-30" || value === "0";
    t.at(numeric ? 61_000 : 9 * 60_000);
    expect(outcome((await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 }))[0])).toBe(numeric ? "ok" : "http_403");
    t.at(10 * 60_000 + 1);
    expect(outcome((await extractArticles(["https://busy.example/b"], { deadline: t.now() + 3_000 }))[0])).toBe("ok");
    expect(pageCalls()[0]).toBe("https://busy.example/a");
  });

  it("a refusal on a redirect hop rests the hop's origin, not the first host", async () => {
    const { pageCalls } = serve({
      "https://short.example/x": redirect("https://wall.example/story"),
      "https://wall.example/story": status(403),
      "https://wall.example/other": page(),
      "https://short.example/y": page(),
    });
    const [r] = await extractArticles(["https://short.example/x"], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("http_403");
    const later = await extractArticles(["https://wall.example/other", "https://short.example/y"], { deadline: soon(3_000) });
    expect(later.map(outcome)).toEqual(["http_403", "ok"]);
    expect(pageCalls()).toEqual(["https://short.example/x", "https://wall.example/story", "https://short.example/y"]);
  });

  it("a redirect into a resting origin stops there, unrequested", async () => {
    const { pageCalls } = serve({
      "https://wall.example/a": status(401),
      "https://short.example/x": redirect("https://wall.example/b"),
    });
    await extractArticles(["https://wall.example/a"], { deadline: soon(3_000) });
    const [r] = await extractArticles(["https://short.example/x"], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("http_401");
    expect(pageCalls()).toEqual(["https://wall.example/a", "https://short.example/x"]);
  });

  it.each([400, 404, 410, 451, 500, 502, 504])("a %i rests nothing", async (code) => {
    const { pageCalls } = serve({ "https://h.example/a": status(code), "https://h.example/b": page() });
    await extractArticles(["https://h.example/a"], { deadline: soon(3_000) });
    const [r] = await extractArticles(["https://h.example/b"], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("ok");
    expect(pageCalls()).toHaveLength(2);
  });
});

// --- 2. the linear wildcard matcher -----------------------------------------------

/** A deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function refMatches(rule: string, p: string): boolean {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + body.split("*").map(esc).join(".*") + (anchored ? "$" : ""), "s").test(p);
}

describe("robots wildcard matcher against a reference RegExp (RFC 9309 semantics)", () => {
  const rand = rng(9309);
  const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");

  it("one rule: matches exactly where the regex does, 20,000 random cases", () => {
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const rule = "/" + pick("ab*$.-", Math.floor(rand() * 7));
      const p = "/" + pick("ab$.-", Math.floor(rand() * 9));
      if (rule === "/" && false) continue;
      const expected = !refMatches(rule, p);
      const got = robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, TOKEN, p);
      if (got !== expected) mismatches.push(`${rule} on ${p}: got allow=${got}`);
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it("several rules: longest match wins, Allow wins a tie, 10,000 random robots files", () => {
    const mismatches: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const rules = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
        allow: rand() < 0.5,
        path: "/" + pick("ab*$", Math.floor(rand() * 5)),
      }));
      const p = "/" + pick("ab$", Math.floor(rand() * 7));
      let best: { allow: boolean; length: number } | null = null;
      for (const r of rules) {
        if (!refMatches(r.path, p)) continue;
        if (!best || r.path.length > best.length || (r.path.length === best.length && r.allow)) best = { allow: r.allow, length: r.path.length };
      }
      const expected = best ? best.allow : true;
      const txt = "User-agent: *\n" + rules.map((r) => `${r.allow ? "Allow" : "Disallow"}: ${r.path}`).join("\n") + "\n";
      const got = robotsAllows(txt, TOKEN, p);
      if (got !== expected) mismatches.push(`${JSON.stringify(rules)} on ${p}: got ${got}`);
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it.each([
    ["/*", "/", true],
    ["*", "/x", true],
    ["/$", "/", true],
    ["/$", "/x", false],
    ["/a*$", "/a", true],
    ["/a*$", "/abc", true],
    ["/a$b", "/a$b", true],
    ["/a$b", "/ab", false],
    ["/a$$", "/a$", true],
    ["/a$$", "/a", false],
    ["/*/b*/c$", "/x/b/y/c", true],
    ["/*/b*/c$", "/x/b/y/cc", false],
    ["/ab*ba", "/aba", false],
    ["/ab*ba", "/abba", true],
    ["/a*a$", "/a", false],
    ["/a*a$", "/aa", true],
  ])("edge: Disallow %s on %s matches = %s", (rule, p, matches) => {
    expect(robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, TOKEN, p)).toBe(!matches);
  });

  it("stays fast on hostile input: 2,000 wildcards, a 200 KB path, and a near-miss literal", () => {
    const cases: [string, string][] = [
      ["/" + "*a".repeat(2_000) + "*b", "/" + "a".repeat(200_000)],
      ["/" + "*a".repeat(2_000) + "*b$", "/" + "a".repeat(200_000)],
      ["/*b" + "a".repeat(20_000), "/" + "a".repeat(200_000)],
      ["/*" + "a".repeat(20_000) + "b", "/" + "a".repeat(200_000)],
    ];
    for (const [rule, p] of cases) {
      const started = performance.now();
      expect(robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, TOKEN, p)).toBe(true);
      const took = performance.now() - started;
      expect(took, `${rule.slice(0, 20)}… took ${Math.round(took)} ms`).toBeLessThan(500);
    }
  });

  it("a 500 KiB robots.txt of wildcard rules against a long path stays under a second", () => {
    const line = "Disallow: /" + "*x".repeat(20) + "*z\n";
    const txt = "User-agent: *\n" + line.repeat(Math.floor((500 * 1024) / line.length));
    const started = performance.now();
    expect(robotsAllows(txt, TOKEN, "/" + "x".repeat(4_000))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

// --- 3. escape normalisation ---------------------------------------------------

describe("escape normalisation, both rule and path", () => {
  it.each([
    ["/%7Euser", "/~user"],
    ["/%7euser", "/~user"],
    ["/~user", "/%7Euser"],
    ["/%61bc", "/abc"],
    ["/abc", "/%61%62%63"],
    ["/a%2db", "/a-b"],
    ["/a%5fb", "/a_b"],
    ["/a%2Eb", "/a.b"],
    ["/caf%c3%a9", "/caf%C3%A9"],
    ["/café", "/caf%c3%a9"],
    ["/a b", "/a%20b"],
    ["/a<b>", "/a%3Cb%3E"],
    ["/`x`", "/%60x%60"],
    ["/{x}", "/%7bx%7d"],
    ['/"q"', "/%22q%22"],
  ])("rule %s matches path %s", (rule, p) => {
    expect(robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, TOKEN, p)).toBe(false);
  });

  it.each([
    ["/a/b", "/a%2Fb"],
    ["/a%2Fb", "/a/b"],
    ["/a?b", "/a%3Fb"],
    ["/100%25", "/100%"],
  ])("a reserved escape is not decoded: rule %s does not match %s", (rule, p) => {
    expect(robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, TOKEN, p)).toBe(true);
  });

  it.each([
    ["^ in a path, which the URL parser escapes", "https://news.example/a^b/story", "/a^b"],
    ["' in a query, which the URL parser escapes for http(s)", "https://news.example/search?q='x'", "/search?q='"],
  ])("%s — a rule written as text still blocks the page", async (_label, url, rule) => {
    const { pageCalls } = serve({
      "https://news.example/robots.txt": () => new Response(`User-agent: *\nDisallow: ${rule}\n`),
      [new URL(url).href]: page(),
    });
    const [r] = await extractArticles([url], { deadline: soon(3_000) });
    expect(outcome(r)).toBe("robots");
    expect(pageCalls()).toEqual([]);
  });
});

// --- 5. charset and the one log line -------------------------------------------

describe("<meta charset> labels for UTF-16 and x-user-defined", () => {
  it.each(["utf-16", "UTF-16LE", "utf-16be", "unicode", "unicodeFFFE", "ucs-2"])(
    "<meta charset=%s> on an ASCII-compatible page is read as UTF-8",
    async (label) => {
      const html = ARTICLE.replace('<meta charset="utf-8">', `<meta charset="${label}">`).replace(
        "The city council voted",
        "Le conseil a voté"
      );
      serve({ "https://news.example/a": page(new TextEncoder().encode(html) as Uint8Array<ArrayBuffer>, "text/html") });
      const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
      expect(r.ok && r.text).toContain("Le conseil a voté");
    }
  );

  it("<meta charset=x-user-defined> is read as windows-1252", async () => {
    const html = ARTICLE.replace('<meta charset="utf-8">', '<meta charset="x-user-defined">').replace(
      "The city council voted",
      "The city council \x93voted\x94"
    );
    const bytes = Uint8Array.from([...html].map((c) => c.charCodeAt(0) & 0xff));
    serve({ "https://news.example/a": page(bytes as Uint8Array<ArrayBuffer>, "text/html") });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
    expect(r.ok && r.text).toContain("council “voted”");
  });

  it("a header naming UTF-16 is still decoded as UTF-16 (the header is not a meta tag)", async () => {
    const html = ARTICLE.replace("The city council voted", "Le conseil a voté");
    const buf = new Uint8Array(html.length * 2);
    for (let i = 0; i < html.length; i++) {
      buf[i * 2] = html.charCodeAt(i) & 0xff;
      buf[i * 2 + 1] = html.charCodeAt(i) >> 8;
    }
    serve({ "https://news.example/a": page(buf as Uint8Array<ArrayBuffer>, "text/html; charset=utf-16le") });
    const [r] = await extractArticles(["https://news.example/a"], { deadline: soon(3_000) });
    expect(r.ok && r.text).toContain("Le conseil a voté");
  });
});

describe("one log line per extractForStory call", () => {
  const lines = () =>
    vi.mocked(console.log).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[extract]") && !l.startsWith("[extract] parser thread"));

  it("three rounds (two fallbacks after failures) still log exactly one line, naming every page tried", async () => {
    serve({
      "https://a.example/1": status(404),
      "https://b.example/1": status(404),
      "https://c.example/1": page(),
      "https://d.example/1": status(404),
      "https://e.example/1": page(),
    });
    const urls = ["https://a.example/1", "https://b.example/1", "https://c.example/1", "https://d.example/1", "https://e.example/1"];
    const results = await extractForStory(urls, { deadline: soon(3_000), label: "expand" });
    expect(results.map(outcome)).toEqual(["http_404", "http_404", "ok", "http_404", "ok"]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^\[extract\] expand 5 pages: http_404=3 ok=2 in \d+ms rss=\d+MB$/);
  });

  it("no URLs, or a deadline already passed, still logs one line of 0 pages", async () => {
    serve({});
    await extractForStory([], { deadline: soon(3_000), label: "writeCard" });
    await extractForStory(["https://a.example/1"], { deadline: Date.now() - 1, label: "writeCard" });
    expect(lines()).toEqual([expect.stringMatching(/^\[extract\] writeCard 0 pages:  in/), expect.stringMatching(/^\[extract\] writeCard 0 pages:  in/)]);
  });
});
