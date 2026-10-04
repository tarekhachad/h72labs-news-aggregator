import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// QA round 7: the heavy-host rule, with node:worker_threads replaced by a fake
// whose answer to each page is chosen by the page's own URL (embedded in the
// HTML as a marker). Fake fetch, mocked DNS, no network.
//
// Page path conventions (on any host):
//   /slow*    the thread never answers (the 1.5 s limit stops it)
//   /oom*     the thread ends with ERR_WORKER_OUT_OF_MEMORY
//   /crash*   the thread ends with an ordinary error
//   /exit*    the thread exits
//   /msgerr*  the thread emits messageerror
//   /refuse*  the thread answers { ok:false, reason:"too_large" } at once
//   /tags*    the page has 20,001 raw tags (refused before the thread)
//   anything else: the thread answers 400 chars of text

type Handler = (arg: unknown) => void;
type Answer = { event: "message" | "error" | "exit" | "messageerror"; arg: unknown } | "silent";

const { workers, FakeWorker } = vi.hoisted(() => {
  const workers: FakeWorkerT[] = [];
  const later = (fn: () => void) => void Promise.resolve().then(fn);
  const urlOf = (html: string) => /<!--U:(.*?)-->/.exec(html)?.[1] ?? "";
  const answerFor = (html: string): Answer => {
    const path = new URL(urlOf(html) || "https://x.invalid/").pathname;
    if (path.startsWith("/slow")) return "silent";
    if (path.startsWith("/oom")) return { event: "error", arg: Object.assign(new Error("heap"), { code: "ERR_WORKER_OUT_OF_MEMORY" }) };
    if (path.startsWith("/crash")) return { event: "error", arg: new Error("boom") };
    if (path.startsWith("/exit")) return { event: "exit", arg: 1 };
    if (path.startsWith("/msgerr")) return { event: "messageerror", arg: new Error("clone") };
    if (path.startsWith("/refuse")) return { event: "message", arg: { ok: false, reason: "too_large" } };
    return { event: "message", arg: { ok: true, text: "x".repeat(400) } };
  };
  class FakeWorkerT {
    handlers = new Map<string, Handler[]>();
    posted: string[] = [];
    terminated = 0;
    constructor() {
      workers.push(this);
      later(() => this.emit("message", { ready: true }));
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, arg: unknown) {
      for (const h of this.handlers.get(event) ?? []) h(arg);
    }
    postMessage(message: { html: string }) {
      this.posted.push(urlOf(message.html));
      const answer = answerFor(message.html);
      if (answer !== "silent") later(() => this.emit(answer.event, answer.arg));
    }
    terminate() {
      this.terminated++;
      return Promise.resolve(1);
    }
    unref() {}
  }
  return { workers, FakeWorker: FakeWorkerT };
});

vi.mock("node:worker_threads", () => ({ Worker: FakeWorker, default: { Worker: FakeWorker } }));
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));

import { extractArticles, extractForStory, MAX_CONCURRENT_PAGES, resetExtractStateForTests, type ExtractResult } from "@/lib/extract";

const pageFor = (u: string) =>
  `<!doctype html><html><head><title>t</title></head><body><!--U:${u}--><p>${"Words about the vote. ".repeat(30)}</p></body></html>`;
const TAGS = (u: string) => `<!--U:${u}-->` + "<b>".repeat(20_001);

/** Location for a URL that redirects (href -> absolute href). */
let redirects: Map<string, string>;
/** Page fetches that wait on this gate (by href), to hold their slots. */
let held: Set<string>;
let release: () => void;
let gate: Promise<void>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetExtractStateForTests();
  workers.length = 0;
  redirects = new Map();
  held = new Set();
  gate = new Promise<void>((r) => (release = r));
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
    const to = redirects.get(href);
    if (to) return new Response(null, { status: 302, headers: { location: to } });
    if (held.has(href)) await gate;
    const body = u.pathname.startsWith("/tags") ? TAGS(href) : pageFor(href);
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const outcome = (r: ExtractResult | undefined) => (r === undefined ? "untried" : r.ok ? "ok" : r.reason);
const outcomes = (rs: (ExtractResult | undefined)[]) => rs.map(outcome);
/** Every request (robots.txt included) whose host, bare and lower-cased, is `host`. */
const requestsTo = (host: string) =>
  fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((h) => new URL(h).hostname.toLowerCase().replace(/\.+$/, "") === host);

/** Runs a page that the thread's own limit stops, so its host(s) become heavy. */
async function makeHeavy(url: string) {
  const p = extractArticles([url], { deadline: Date.now() + 8_000 });
  await vi.advanceTimersByTimeAsync(1_501);
  expect(outcomes(await p)).toEqual(["timeout"]);
}

/** One page, expected to be answered at once (no timer needed). */
async function one(url: string) {
  const p = extractArticles([url], { deadline: Date.now() + 8_000 });
  await vi.advanceTimersByTimeAsync(0);
  return outcome((await p)[0]);
}

describe("triggers", () => {
  it("own time limit, no redirect: the host's other pages are too_large and never requested (robots.txt included)", async () => {
    vi.useFakeTimers();
    await makeHeavy("https://bad.example/slow1");
    const before = requestsTo("bad.example").length;
    expect(await one("https://bad.example/2")).toBe("too_large");
    expect(await one("https://bad.example/3")).toBe("too_large");
    expect(requestsTo("bad.example").length).toBe(before);
  });

  it("memory cap: the same", async () => {
    vi.useFakeTimers();
    expect(await one("https://big.example/oom1")).toBe("too_large");
    const before = requestsTo("big.example").length;
    expect(await one("https://big.example/2")).toBe("too_large");
    expect(requestsTo("big.example").length).toBe(before);
  });

  it("redirect good -> bad, slow page on bad: BOTH hosts become heavy (good.example's other pages are suppressed too)", async () => {
    vi.useFakeTimers();
    redirects.set("https://good.example/r1", "https://bad.example/slow1");
    await makeHeavy("https://good.example/r1");
    const goodBefore = requestsTo("good.example").length;
    expect(await one("https://good.example/real-story")).toBe("too_large");
    expect(await one("https://bad.example/2")).toBe("too_large");
    expect(requestsTo("good.example").length).toBe(goodBefore);
  });

  it("redirect bad -> good, slow page on good: both heavy", async () => {
    vi.useFakeTimers();
    redirects.set("https://bad.example/r", "https://good.example/slow");
    await makeHeavy("https://bad.example/r");
    expect(await one("https://good.example/2")).toBe("too_large");
    expect(await one("https://bad.example/2")).toBe("too_large");
  });

  it("memory cap through a redirect marks the start host too", async () => {
    vi.useFakeTimers();
    redirects.set("https://start.example/r", "https://final.example/oom");
    expect(await one("https://start.example/r")).toBe("too_large");
    expect(await one("https://start.example/other")).toBe("too_large");
    expect(await one("https://final.example/other")).toBe("too_large");
    expect(requestsTo("start.example").filter((h) => !h.endsWith("/robots.txt"))).toEqual(["https://start.example/r"]);
  });

  it("host variants: http, upper case, trailing dot(s), explicit default port all count as the same host", async () => {
    vi.useFakeTimers();
    await makeHeavy("https://bad.example/slow1");
    const before = requestsTo("bad.example").length;
    for (const u of [
      "http://bad.example/a",
      "https://BAD.EXAMPLE/b",
      "https://bad.example./c",
      "http://Bad.Example../d",
      "https://bad.example:443/e",
      "http://bad.example:80/f",
    ]) {
      expect([u, await one(u)]).toEqual([u, "too_large"]);
    }
    expect(requestsTo("bad.example").length).toBe(before);
  });

  it("a subdomain is a different host (www.bad.example is not covered)", async () => {
    vi.useFakeTimers();
    await makeHeavy("https://bad.example/slow1");
    expect(await one("https://www.bad.example/a")).toBe("ok");
  });

  it("marked when the trailing-dot form is the one that was slow", async () => {
    vi.useFakeTimers();
    await makeHeavy("http://BAD.example./slow1");
    expect(await one("https://bad.example/a")).toBe("too_large");
  });
});

describe("non-triggers: the host's next page is still fetched and extracted", () => {
  it("the caller's deadline (1,499 ms left at hand-over) is not heavy; exactly 1,500 ms left is", async () => {
    vi.useFakeTimers();
    const a = extractArticles(["https://a.example/slow"], { deadline: Date.now() + 1_499 });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(outcomes(await a)).toEqual(["timeout"]);
    expect(await one("https://a.example/next")).toBe("ok");

    const b = extractArticles(["https://b.example/slow"], { deadline: Date.now() + 1_500 });
    await vi.advanceTimersByTimeAsync(1_501);
    expect(outcomes(await b)).toEqual(["timeout"]);
    expect(await one("https://b.example/next")).toBe("too_large");
  });

  it.each(["crash", "exit", "msgerr", "refuse", "tags"])("%s", async (kind) => {
    vi.useFakeTimers();
    const first = await one(`https://${kind}.example/${kind}`);
    expect(first === "error" || first === "too_large").toBe(true);
    expect(await one(`https://${kind}.example/next`)).toBe("ok");
  });

  it("a page queued past its deadline (waitTimer) is not heavy", async () => {
    vi.useFakeTimers();
    const p = extractArticles(["https://x.example/slow", "https://q.example/queued"], { deadline: Date.now() + 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(outcomes(await p)).toEqual(["timeout", "timeout"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await one("https://q.example/next")).toBe("ok");
    expect(await one("https://x.example/next")).toBe("ok");
  });
});

describe("expiry and the 500-host cap", () => {
  it("heavy just before ten minutes, not just after", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    await makeHeavy("https://bad.example/slow1");
    // Marked at t0 + 1,500 (when the time limit fired).
    vi.setSystemTime(t0 + 1_500 + 10 * 60 * 1000 - 5);
    expect(await one("https://bad.example/2")).toBe("too_large");
    vi.setSystemTime(t0 + 1_500 + 10 * 60 * 1000 + 5);
    expect(await one("https://bad.example/3")).toBe("ok");
  });

  it("the 501st heavy host evicts the oldest, and only the oldest", async () => {
    vi.useFakeTimers();
    // The memory cap marks without fake time passing (501 time limits would be 12.5 min, past expiry).
    const t0 = Date.now();
    for (let i = 0; i <= 500; i++) expect(await one(`https://h${i}.example/oom`)).toBe("too_large");
    expect(Date.now()).toBe(t0);
    expect(await one("https://h0.example/again")).toBe("ok");
    expect(await one("https://h1.example/again")).toBe("too_large");
    expect(await one("https://h500.example/again")).toBe("too_large");
  }, 60_000);
});

describe("pages already queued when their host turns heavy", () => {
  it("are skipped at hand-over; the rest keep their order, results and slots; no timer left", async () => {
    vi.useFakeTimers();
    const urls = [
      "https://bad.example/slow1",
      "https://g1.example/a",
      "https://bad.example/2",
      "https://g2.example/a",
      "https://bad.example/3",
      "https://g3.example/a",
    ];
    const p = extractArticles(urls, { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(1_501);
    expect(outcomes(await p)).toEqual(["timeout", "ok", "too_large", "ok", "too_large", "ok"]);
    expect(workers).toHaveLength(2);
    expect(workers[0].posted).toEqual(["https://bad.example/slow1"]);
    expect(workers[1].posted).toEqual(["https://g1.example/a", "https://g2.example/a", "https://g3.example/a"]);
    // Only the idle timer remains.
    expect(vi.getTimerCount()).toBe(1);
    // All 8 slots free: exactly 8 held fetches start together.
    const hold = Array.from({ length: MAX_CONCURRENT_PAGES + 3 }, (_, i) => `https://hold${i}.example/a`);
    hold.forEach((h) => held.add(h));
    const q = extractArticles(hold, { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(0);
    const pageFetches = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("hold") && !String(c[0]).endsWith("robots.txt")).length;
    expect(pageFetches()).toBe(MAX_CONCURRENT_PAGES);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes(await q).every((o) => o === "ok")).toBe(true);
  });

  it("a skipped page settles at once even when its own deadline is far, and a later queued page keeps its own (shorter) deadline", async () => {
    vi.useFakeTimers();
    const long = extractArticles(["https://bad.example/slow1", "https://bad.example/2"], { deadline: Date.now() + 15_000 });
    const short = extractArticles(["https://s.example/a"], { deadline: Date.now() + 1_200 });
    await vi.advanceTimersByTimeAsync(1_201);
    expect(outcomes(await short)).toEqual(["timeout"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(outcomes(await long)).toEqual(["timeout", "too_large"]);
  });
});

describe("requests to a heavy host during its ten minutes (what the rule does NOT stop)", () => {
  it("a page waiting for a slot when its host turns heavy is still FETCHED (then skipped at hand-over)", async () => {
    vi.useFakeTimers();
    const holders = Array.from({ length: MAX_CONCURRENT_PAGES - 1 }, (_, i) => `https://f${i}.example/a`);
    holders.forEach((h) => held.add(h));
    // slow1 + 7 held = 8 slots; bad.example/2 waits for a slot.
    const p = extractArticles(["https://bad.example/slow1", ...holders, "https://bad.example/2"], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(1_501);
    release();
    await vi.advanceTimersByTimeAsync(0);
    const r = await p;
    expect(outcome(r[0])).toBe("timeout");
    expect(outcome(r[r.length - 1])).toBe("too_large");
    const pages = requestsTo("bad.example").filter((h) => !h.endsWith("/robots.txt"));
    process.stdout.write(`[qa7] page requests to bad.example: ${JSON.stringify(pages)}\n`);
    expect(pages).toEqual(["https://bad.example/slow1", "https://bad.example/2"]);
  });

  it("a redirect from another host INTO a heavy host requests it (robots.txt for a new origin, and the page)", async () => {
    vi.useFakeTimers();
    await makeHeavy("https://bad.example/slow1");
    const before = requestsTo("bad.example");
    redirects.set("https://other.example/r", "http://bad.example/x");
    expect(await one("https://other.example/r")).toBe("too_large");
    const during = requestsTo("bad.example").slice(before.length);
    process.stdout.write(`[qa7] requests to heavy bad.example via redirect: ${JSON.stringify(during)}\n`);
    expect(during).toEqual(["http://bad.example/robots.txt", "http://bad.example/x"]);
  });

  it("first round of a digest: every page of the outlet is started before any is parsed, so all are fetched", async () => {
    vi.useFakeTimers();
    const stories = Array.from({ length: 10 }, (_, i) => [`https://bad.example/${i === 0 ? "slow" : "p"}-${i}`, `https://g${i}.example/a`, `https://k${i}.example/a`, `https://m${i}.example/a`, `https://n${i}.example/a`]);
    const all = Promise.all(stories.map((u) => extractForStory(u, { deadline: Date.now() + 15_000 })));
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await all;
    const badPages = requestsTo("bad.example").filter((h) => !h.endsWith("/robots.txt")).length;
    const badOutcomes = r.map((s) => outcome(s[0]));
    const goodOk = r.flatMap((s) => s.slice(1)).filter((x) => x?.ok).length;
    process.stdout.write(`[qa7] digest round 1: ${badPages} page requests to bad.example after/around marking; bad outcomes ${badOutcomes.join(",")}; good ok ${goodOk}\n`);
    expect(badPages).toBe(10);
  });
});

describe("cost of one legitimately slow page", () => {
  it("one slow page from an outlet in all ten stories: its other nine pages are lost for the run", async () => {
    vi.useFakeTimers();
    const stories = Array.from({ length: 10 }, (_, i) => [
      `https://big.example/${i === 0 ? "slow" : "story"}-${i}`,
      `https://g${i}.example/a`,
      `https://k${i}.example/a`,
      `https://m${i}.example/a`,
    ]);
    const all = Promise.all(stories.map((u) => extractForStory(u, { deadline: Date.now() + 15_000 })));
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await all;
    const big = r.map((s) => outcome(s[0]));
    process.stdout.write(`[qa7] big.example pages: ${big.join(",")}\n`);
    expect(big.filter((o) => o === "too_large").length).toBeGreaterThanOrEqual(1);
    // Every story still gets its 3 full texts from the other outlets.
    expect(r.every((s) => s.filter((x) => x?.ok).length === 3)).toBe(true);
  });
});

describe("the reset path", () => {
  it("settles a page mid-parse and one queued behind it, frees their slots, leaves no timer", async () => {
    vi.useFakeTimers();
    const p = extractArticles(["https://a.example/slow", "https://b.example/queued"], { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(workers[0].posted).toEqual(["https://a.example/slow"]);
    resetExtractStateForTests();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes(await p)).toEqual(["error", "error"]);
    expect(workers[0].terminated).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    // Slots: 8 held fetches start together.
    const hold = Array.from({ length: MAX_CONCURRENT_PAGES + 2 }, (_, i) => `https://hold${i}.example/a`);
    hold.forEach((h) => held.add(h));
    const q = extractArticles(hold, { deadline: Date.now() + 8_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("hold") && !String(c[0]).endsWith("robots.txt")).length).toBe(MAX_CONCURRENT_PAGES);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes(await q).every((o) => o === "ok")).toBe(true);
  });

  it("a reset during the stopped thread's replacement start does not mark anything or leave a timer", async () => {
    vi.useFakeTimers();
    await makeHeavy("https://bad.example/slow1");
    resetExtractStateForTests();
    expect(vi.getTimerCount()).toBe(0);
    expect(await one("https://bad.example/2")).toBe("ok");
  });
});
