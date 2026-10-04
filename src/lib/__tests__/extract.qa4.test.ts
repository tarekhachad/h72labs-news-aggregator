import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// QA round 4. No real DNS: every lookup goes through mockLookup. No real web:
// every request goes to a fake web, and an unknown URL fails the test.
// The clock helper only adds an offset to the real clock, so every timer the
// extractor sets (AbortSignal.timeout, the deadline race) runs on real time
// and agrees with Date.now.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractArticles, resetExtractStateForTests, robotsAllows, type ExtractResult } from "@/lib/extract";

const ARTICLE = readFileSync(path.join(__dirname, "fixtures/extract/article.html"), "utf8");
const TOKEN = "H72NewsAggregator";
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

type Handler = (req: { url: string; init: RequestInit }) => Response | Promise<Response>;

function serve(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const handler = routes[url];
      if (handler) return handler({ url, init });
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      throw new Error(`unexpected fetch in test: ${url}`);
    })
  );
  return {
    urls: () => [...calls],
    pageCalls: () => calls.filter((u) => !u.endsWith("/robots.txt")),
    robotsCalls: () => calls.filter((u) => u.endsWith("/robots.txt")),
  };
}

const page = () => () => new Response(ARTICLE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const status = (code: number, headers: Record<string, string> = {}) => () => new Response("", { status: code, headers });
const outcome = (r: ExtractResult | undefined) => (r === undefined ? "untried" : r.ok ? "ok" : r.reason);

function clock() {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  return { at: (ms: number) => (offset = ms), now: () => Date.now() };
}

async function one(url: string, ms = 3_000) {
  const [r] = await extractArticles([url], { deadline: Date.now() + ms });
  return outcome(r);
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

// --- 5. the IPv6 reader ----------------------------------------------------------

describe("IPv6: only global unicast is public", () => {
  async function resolveTo(address: string) {
    mockLookup.mockImplementation(async (host: string) =>
      host === "target.example" ? [{ address, family: address.includes(":") ? 6 : 4 }] : PUBLIC
    );
    const { urls } = serve({ "https://target.example/a": page() });
    return { r: await one("https://target.example/a"), requested: urls() };
  }

  it.each([
    ["a lone colon", ":"],
    ["triple colon", ":::"],
    ["two :: runs", "1::2::3"],
    ["two :: runs, global-looking", "2606::1::2"],
    ["leading single colon", ":2606:4700:1:2:3:4:5"],
    ["leading single colon before ::", ":2606::1"],
    ["trailing single colon", "2606:4700:1:2:3:4:5:"],
    ["trailing single colon after ::", "2606::1:"],
    ["nine groups", "2606:4700:1:2:3:4:5:6:7"],
    ["seven groups, no ::", "2606:4700:1:2:3:4:5"],
    [":: standing for zero groups (8 written)", "2606:4700::1:2:3:4:5:6"],
    [":: at the front with 8 written", "::2606:1:2:3:4:5:6:7"],
    ["five-digit group", "20606::1"],
    ["leading-zero five-digit group", "02606::1"],
    ["non-hex group", "2g06::1"],
    ["a sign in a group", "+2606::1"],
    ["a space in a group", "2606: 4700::1"],
    ["dotted tail on a global prefix", "2606:4700::1.2.3.4"],
    ["dotted tail, mapped", "::ffff:8.8.8.8"],
    ["zone before the address", "%2606::1"],
    ["documentation-like but 6to4 (2002::/16)", "2002:808:808::1"],
    ["Teredo 2001:0::/32", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["Teredo written with 0000", "2001:0000::1"],
    ["below 2000::/3", "1fff:ffff::1"],
    ["above 2000::/3", "4000::1"],
    ["ULA uppercase", "FD00:EC2::254"],
    ["link-local uppercase", "FE80::1"],
    ["NAT64 well-known prefix", "64:ff9b::808:808"],
    ["NAT64 local-use prefix", "64:ff9b:1::1"],
    ["discard-only 100::/64", "100::1"],
    ["IPv4-compatible in hex", "::808:808"],
    ["all zeros spelled out", "0:0:0:0:0:0:0:0"],
  ])("%s (%j) is refused, with no request", async (_label, address) => {
    const { r, requested } = await resolveTo(address);
    expect(r).toBe("error");
    expect(requested).toEqual([]);
  });

  it.each([
    ["compressed", "2606:4700::1111"],
    ["uppercase", "2A00:1450:4001::200E"],
    ["mixed case", "2a00:1450:4001:0:0:0:0:200E"],
    ["fully written", "2606:4700:0000:0000:0000:0000:0000:1111"],
    [":: at the end standing for one group", "2606:4700:1:2:3:4:5::"],
    [":: in the middle standing for one group", "2606:4700:1:2::4:5:6"],
    ["2001 but not Teredo (second group non-zero)", "2001:1::1"],
    ["top of 2000::/3", "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["zone on a global address", "2606:4700::1111%eth0"],
  ])("%s (%j) is public", async (_label, address) => {
    const { r } = await resolveTo(address);
    expect(r).toBe("ok");
  });

  it("one unreadable address among public ones refuses the name", async () => {
    mockLookup.mockImplementation(async (host: string) =>
      host === "target.example"
        ? [
            { address: "2606:4700::1111", family: 6 },
            { address: "93.184.216.34", family: 4 },
            { address: "2606::1::2", family: 6 },
          ]
        : PUBLIC
    );
    const { urls } = serve({ "https://target.example/a": page() });
    expect(await one("https://target.example/a")).toBe("error");
    expect(urls()).toEqual([]);
  });

  it.each([
    ["https://[::ffff:169.254.169.254]/a", "mapped metadata, which the URL parser rewrites to hex"],
    ["https://[::1]/a", "loopback"],
    ["https://[fd00:ec2::254]/a", "AWS IPv6 metadata"],
    ["https://[2002:a9fe:a9fe::1]/a", "6to4 of the metadata address"],
    ["https://[64:ff9b::a9fe:a9fe]/a", "NAT64 of the metadata address"],
  ])("an IPv6 literal URL %s (%s) is refused unrequested and unlooked-up", async (url) => {
    const { urls } = serve({});
    expect(await one(url)).toBe("error");
    expect(urls()).toEqual([]);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("a global IPv6 literal URL is fetched without a lookup", async () => {
    const { urls } = serve({ "https://[2606:4700::1111]/a": page() });
    expect(await one("https://[2606:4700::1111]/a")).toBe("ok");
    expect(urls()).toEqual(["https://[2606:4700::1111]/robots.txt", "https://[2606:4700::1111]/a"]);
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

// --- 1. rests are checked before robots.txt ----------------------------------------

describe("robots.txt answers that rest the host", () => {
  it("robots 429 with Retry-After 120: refused as resting (http_429) while it rests, then as robots, then asked again after 10 min", async () => {
    const t = clock();
    const { urls } = serve({
      "https://busy.example/robots.txt": status(429, { "retry-after": "120" }),
      "https://busy.example/a": page(),
    });
    expect(await one("https://busy.example/a")).toBe("robots");
    t.at(60_000);
    // The rest is consulted before the (cached) robots answer.
    expect(await one("https://busy.example/a")).toBe("http_429");
    t.at(3 * 60_000);
    // Rest over, robots cache (10 min) still says unreachable: nothing sent.
    expect(await one("https://busy.example/a")).toBe("robots");
    expect(urls()).toEqual(["https://busy.example/robots.txt"]);
    t.at(11 * 60_000);
    expect(await one("https://busy.example/a")).toBe("robots");
    expect(urls()).toEqual(["https://busy.example/robots.txt", "https://busy.example/robots.txt"]);
  });

  it("robots 503 with no Retry-After rests the host the default 10 min (http_503 at 9:50, unrequested)", async () => {
    const t = clock();
    const { urls } = serve({
      "https://busy.example/robots.txt": status(503),
      "https://busy.example/a": page(),
    });
    expect(await one("https://busy.example/a")).toBe("robots");
    t.at(9 * 60_000 + 50_000);
    expect(await one("https://busy.example/a")).toBe("http_503");
    t.at(10 * 60_000 + 30_000);
    expect(await one("https://busy.example/a")).not.toBe("ok");
    expect(urls()).toEqual(["https://busy.example/robots.txt", "https://busy.example/robots.txt"]);
  });

  it.each([500, 502, 504])("robots %i refuses as robots but rests nothing", async (code) => {
    const t = clock();
    const { urls } = serve({
      "https://flaky.example/robots.txt": status(code, { "retry-after": "3600" }),
      "https://flaky.example/a": page(),
    });
    expect(await one("https://flaky.example/a")).toBe("robots");
    t.at(60_000);
    expect(await one("https://flaky.example/a")).toBe("robots");
    t.at(11 * 60_000);
    expect(await one("https://flaky.example/a")).toBe("robots");
    expect(urls()).toEqual(["https://flaky.example/robots.txt", "https://flaky.example/robots.txt"]);
  });

  it("a robots redirect whose target answers 429 rests the target origin, not the first", async () => {
    const { urls } = serve({
      "https://first.example/robots.txt": () =>
        new Response(null, { status: 301, headers: { location: "https://cdn.example/robots.txt" } }),
      "https://cdn.example/robots.txt": status(429, { "retry-after": "3600" }),
      "https://cdn.example/page": page(),
      "https://first.example/a": page(),
    });
    expect(await one("https://first.example/a")).toBe("robots");
    expect(await one("https://cdn.example/page")).toBe("http_429");
    expect(urls()).toEqual(["https://first.example/robots.txt", "https://cdn.example/robots.txt"]);
  });

  it("a resting host on a page's second hop: neither its robots.txt nor its page is asked, and the DNS check still ran", async () => {
    const { urls } = serve({
      "https://wall.example/x": status(402),
      "https://short.example/s": () => new Response(null, { status: 307, headers: { location: "https://wall.example/y" } }),
    });
    expect(await one("https://wall.example/x")).toBe("http_402");
    const before = urls().length;
    expect(await one("https://short.example/s")).toBe("http_402");
    expect(urls().slice(before)).toEqual(["https://short.example/robots.txt", "https://short.example/s"]);
  });

  it("slots are all free after a burst of rest refusals: 9 pages on 9 open hosts all load", async () => {
    const routes: Record<string, Handler> = {};
    for (let i = 0; i < 20; i++) routes[`https://r${i}.example/robots.txt`] = status(429);
    for (let i = 0; i < 9; i++) routes[`https://o${i}.example/a`] = page();
    serve(routes);
    await extractArticles(
      Array.from({ length: 20 }, (_, i) => `https://r${i}.example/a`),
      { deadline: Date.now() + 3_000 }
    );
    const again = await extractArticles(
      Array.from({ length: 20 }, (_, i) => `https://r${i}.example/b`),
      { deadline: Date.now() + 3_000 }
    );
    expect(new Set(again.map(outcome))).toEqual(new Set(["http_429"]));
    const started = Date.now();
    const open = await extractArticles(
      Array.from({ length: 9 }, (_, i) => `https://o${i}.example/a`),
      { deadline: Date.now() + 3_000 }
    );
    expect(open.map(outcome)).toEqual(Array(9).fill("ok"));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// --- 2. eviction ---------------------------------------------------------------------

describe("rest eviction at 500 entries", () => {
  it("with all 500 rests still running, only the one ending soonest is dropped", async () => {
    const t = clock();
    const routes: Record<string, Handler> = {
      "https://soon.example/a": status(429, { "retry-after": "60" }),
      "https://soon.example/b": page(),
      "https://long.example/a": status(403, { "retry-after": "3600" }),
      "https://long.example/b": page(),
      "https://new.example/a": status(403),
    };
    const many = Array.from({ length: 498 }, (_, i) => `https://h${i}.example/a`);
    for (const u of many) routes[u] = status(403);
    for (let i = 0; i < 498; i++) routes[`https://h${i}.example/b`] = page();
    const { pageCalls } = serve(routes);

    await one("https://long.example/a");
    await one("https://soon.example/a");
    await extractArticles(many, { deadline: Date.now() + 20_000 });
    // 500 running rests; the soonest ends at +60 s. Add a 501st at +5 s.
    t.at(5_000);
    expect(await one("https://new.example/a")).toBe("http_403");

    const before = pageCalls().length;
    // soon.example was dropped: it is asked (early, by design of the cap).
    expect(await one("https://soon.example/b")).toBe("ok");
    // Nothing else was dropped.
    expect(await one("https://long.example/b")).toBe("http_403");
    const sample = await extractArticles(
      [0, 1, 250, 497].map((i) => `https://h${i}.example/b`),
      { deadline: Date.now() + 3_000 }
    );
    expect(sample.map(outcome)).toEqual(Array(4).fill("http_403"));
    expect(pageCalls().slice(before)).toEqual(["https://soon.example/b"]);
  }, 30_000);
});

// --- 3. DNS caching -------------------------------------------------------------------

describe("DNS answers: 10 min when public, 30 s when not", () => {
  const lookupsFor = (host: string) => mockLookup.mock.calls.filter((c) => c[0] === host).length;

  it("a successful lookup is reused at 9:59 and redone at 10:00", async () => {
    const t = clock();
    serve({ "https://ok.example/a": page() });
    await one("https://ok.example/a");
    t.at(9 * 60_000 + 59_000);
    await one("https://ok.example/a");
    expect(lookupsFor("ok.example")).toBe(1);
    t.at(10 * 60_000 + 1_000);
    await one("https://ok.example/a");
    expect(lookupsFor("ok.example")).toBe(2);
  });

  it("a failed lookup is reused at 29 s (no second lookup, still refused) and redone at 31 s", async () => {
    const t = clock();
    mockLookup.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    const { urls } = serve({ "https://flaky.example/a": page() });
    expect(await one("https://flaky.example/a")).toBe("error");
    t.at(29_000);
    expect(await one("https://flaky.example/a")).toBe("error");
    expect(lookupsFor("flaky.example")).toBe(1);
    expect(urls()).toEqual([]);
    t.at(31_000);
    expect(await one("https://flaky.example/a")).toBe("ok");
    expect(lookupsFor("flaky.example")).toBe(2);
  });

  it("a name that resolved to a private address is also only kept 30 s", async () => {
    const t = clock();
    mockLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    serve({ "https://moved.example/a": page() });
    expect(await one("https://moved.example/a")).toBe("error");
    t.at(31_000);
    expect(await one("https://moved.example/a")).toBe("ok");
    expect(lookupsFor("moved.example")).toBe(2);
  });

  it("the 30 s run from when a slow lookup failed, not from when it started", async () => {
    const t = clock();
    mockLookup.mockImplementationOnce(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("EAI_AGAIN")), 300))
    );
    serve({ "https://slow.example/a": page() });
    // Shift the clock forward while the lookup is pending: it fails "at" +20 s.
    const p = one("https://slow.example/a", 60_000);
    await vi.waitFor(() => expect(lookupsFor("slow.example")).toBe(1));
    t.at(20_000);
    expect(await p).toBe("error");
    t.at(20_000 + 29_000);
    expect(await one("https://slow.example/a")).toBe("error");
    expect(lookupsFor("slow.example")).toBe(1);
    t.at(20_000 + 31_000);
    expect(await one("https://slow.example/a")).toBe("ok");
    expect(lookupsFor("slow.example")).toBe(2);
  });

  it("concurrent callers share one lookup, failed or not", async () => {
    mockLookup.mockImplementation(
      (host: string) =>
        new Promise((resolve, reject) =>
          setTimeout(() => (host === "bad.example" ? reject(new Error("x")) : resolve(PUBLIC)), 50)
        )
    );
    serve({ "https://good.example/1": page(), "https://good.example/2": page(), "https://good.example/3": page() });
    const r = await extractArticles(
      ["https://good.example/1", "https://good.example/2", "https://good.example/3", "https://bad.example/1", "https://bad.example/2"],
      { deadline: Date.now() + 3_000 }
    );
    expect(r.map(outcome)).toEqual(["ok", "ok", "ok", "error", "error"]);
    expect(lookupsFor("good.example")).toBe(1);
    expect(lookupsFor("bad.example")).toBe(1);
  });
});

// --- 4. parsed robots cache --------------------------------------------------------------

describe("robots rules cached parsed", () => {
  it("one robots.txt fetch serves many paths, each judged by the cached rules", async () => {
    const robots = [
      "User-agent: OtherBot",
      "Disallow: /",
      "",
      "User-agent: h72newsaggregator/2.0",
      "Disallow: /private",
      "Allow: /private/ok",
      "",
      "User-agent: *",
      "Disallow: /news",
    ].join("\n");
    const routes: Record<string, Handler> = { "https://site.example/robots.txt": () => new Response(robots) };
    const paths = ["/news/1", "/private/x", "/private/ok/1", "/other"];
    for (const p of paths) routes[`https://site.example${p}`] = page();
    const { robotsCalls, pageCalls } = serve(routes);
    const r = await extractArticles(
      paths.map((p) => `https://site.example${p}`),
      { deadline: Date.now() + 3_000 }
    );
    expect(r.map(outcome)).toEqual(["ok", "robots", "ok", "ok"]);
    expect(robotsCalls()).toEqual(["https://site.example/robots.txt"]);
    expect(pageCalls()).toEqual(["https://site.example/news/1", "https://site.example/private/ok/1", "https://site.example/other"]);
    // Same answers as the exported text-based check.
    for (const [i, p] of paths.entries()) expect(robotsAllows(robots, TOKEN, p)).toBe(r[i].ok);
  });
});

// --- 6. ^ and ' -------------------------------------------------------------------------

describe("^ and ' escaped on both sides", () => {
  it.each([
    ["/a^b", "/a%5Eb"],
    ["/a%5eb", "/a^b"],
    ["/a%5Eb", "/a%5eb"],
    ["/it's", "/it%27s"],
    ["/it%27s", "/it's"],
    ["/q?x='", "/q?x=%27"],
    ["/q?x=%27", "/q?x='"],
    ["/*^*$", "/x^y^"],
    ["/*'$", "/it'"],
  ])("rule %s matches path %s", (rule, p) => {
    expect(robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, TOKEN, p)).toBe(false);
  });

  it.each([
    ["/a^b", "/a%5Ec"],
    ["/it's", "/its"],
    ["/a%5E", "/a%5F"],
  ])("rule %s does not match %s", (rule, p) => {
    expect(robotsAllows(`User-agent: *\nDisallow: ${rule}\n`, TOKEN, p)).toBe(true);
  });

  it("Allow written with ' wins a tie against Disallow written with %27", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /it%27s\nAllow: /it's\n", TOKEN, "/it's")).toBe(true);
  });

  it.each([
    ["https://news.example/it's-here", "/it%27s"],
    ["https://news.example/x?q=%27", "/x?q='"],
    ["https://news.example/a%5eb", "/a^b"],
  ])("live: %s is refused by rule %s", async (url, rule) => {
    const { pageCalls } = serve({
      "https://news.example/robots.txt": () => new Response(`User-agent: *\nDisallow: ${rule}\n`),
      [new URL(url).href]: page(),
    });
    expect(await one(url)).toBe("robots");
    expect(pageCalls()).toEqual([]);
  });
});
