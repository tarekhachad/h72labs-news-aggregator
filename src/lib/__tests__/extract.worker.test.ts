import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real parser thread against pages that take too long: it is stopped,
// replaced, and leaves nothing held. Synthetic HTML, served by a fake fetch.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
import { extractArticles, extractForStory, MAX_CONCURRENT_PAGES, MAX_HTML_BYTES, resetExtractStateForTests } from "@/lib/extract";

const wrap = (b: string) => `<!doctype html><html><head><title>t</title></head><body>${b}</body></html>`;
const chain = (d: number, inner: string) => "<div>".repeat(d) + inner + "</div>".repeat(d);
const GOOD = wrap("<article><h1>Vote</h1><p>" + "A long enough sentence about the council vote, with words. ".repeat(12) + "</p></article>");
// About 4 s of Readability, inside both element limits and well inside the
// thread's memory: only the time limit stops it.
const SLOW = wrap(Array.from({ length: 317 }, () => chain(62, "x<br>")).join(""));
// Millions of text nodes: past the thread's memory cap in about a second.
const HEAVY = wrap('<div class="comment">' + "<<".repeat(Math.floor((MAX_HTML_BYTES - 200) / 2)) + "</div>");

let logs: string[];

beforeEach(() => {
  resetExtractStateForTests();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      const body = u.includes("/slow") ? SLOW : u.includes("/heavy") ? HEAVY : GOOD;
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    })
  );
  logs = [];
  const keep = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const reasons = (rs: { ok: boolean; reason?: string }[]) => rs.map((r) => (r.ok ? "ok" : r.reason));
const starts = () => logs.filter((l) => l.includes("parser thread started")).length;

describe("the real parser thread", () => {
  it("a page past its time is timeout in about 1.5 s, and the next page gets a fresh thread", async () => {
    const started = performance.now();
    const [slow] = await extractArticles(["https://a.example/slow"], { deadline: Date.now() + 8_000 });
    const ms = performance.now() - started;
    expect(reasons([slow])).toEqual(["timeout"]);
    expect(ms).toBeLessThan(2_500);
    const [good] = await extractArticles(["https://other.example/good"], { deadline: Date.now() + 8_000 });
    expect(reasons([good])).toEqual(["ok"]);
    expect(starts()).toBe(2);
  });

  it("a page past the thread's memory is refused, and the process carries on", async () => {
    const [heavy] = await extractArticles(["https://a.example/heavy"], { deadline: Date.now() + 8_000 });
    // Whichever limit it reaches first: both refuse it.
    expect(["too_large", "timeout"]).toContain(heavy.ok ? "ok" : heavy.reason);
    const [good] = await extractArticles(["https://other.example/good"], { deadline: Date.now() + 8_000 });
    expect(reasons([good])).toEqual(["ok"]);
  });

  it("good pages behind a stuck one still extract once it is stopped", async () => {
    const urls = ["https://a.example/slow", "https://b.example/good", "https://c.example/good"];
    const r = await extractArticles(urls, { deadline: Date.now() + 8_000 });
    expect(reasons(r)).toEqual(["timeout", "ok", "ok"]);
  });

  it("the caller's deadline wins over the 1.5 s limit", async () => {
    const started = performance.now();
    const [slow] = await extractArticles(["https://a.example/slow"], { deadline: Date.now() + 500 });
    expect(reasons([slow])).toEqual(["timeout"]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("stopping a thread leaks no page slot", async () => {
    await extractArticles(["https://a.example/slow", "https://b.example/heavy"], { deadline: Date.now() + 8_000 });
    const urls = Array.from({ length: MAX_CONCURRENT_PAGES * 2 }, (_, i) => `https://s${i}.example/good`);
    const r = await extractArticles(urls, { deadline: Date.now() + 8_000 });
    expect(reasons(r).every((x) => x === "ok")).toBe(true);
  });

  it("one outlet serving slow pages across ten stories costs the run one time limit, not ten", async () => {
    const stories = Array.from({ length: 10 }, (_, i) => [
      `https://bad.example/slow-${i}`,
      `https://bad.example/heavy-${i}`,
      `https://g${i}.example/good`,
      `https://h${i}.example/good`,
      `https://k${i}.example/good`,
    ]);
    const started = performance.now();
    const results = await Promise.all(stories.map((urls) => extractForStory(urls, { deadline: Date.now() + 15_000 })));
    const ms = performance.now() - started;
    const good = results.flatMap((r) => r.slice(2)).filter((x) => x?.ok).length;
    console.info(`[qa] one bad outlet in 10 stories: ${good}/30 good pages extracted in ${Math.round(ms)} ms`);
    expect(good).toBe(30);
    expect(ms).toBeLessThan(6_000);
  }, 30_000);
});

