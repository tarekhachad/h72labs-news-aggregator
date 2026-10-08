import { it, expect, vi, beforeEach, afterEach } from "vitest";

// QA round 6: the REAL parser thread against round 5's attack shapes and new
// ones, through extractArticles and extractForStory, with a main-thread
// interval measuring how long the server's event loop is ever held.
// Synthetic HTML only, served by a fake fetch; DNS mocked; no network.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
import {
  extractArticles,
  extractForStory,
  MAX_CONCURRENT_PAGES,
  MAX_HTML_BYTES,
  PARSE_TIMEOUT_MS,
  resetExtractStateForTests,
  type ExtractResult,
} from "@/lib/extract";
import { describeStress as describe, SLOW_CPU_SLACK_MS, SLOW_PAGE } from "./helpers/parseTiming";

// Minutes of real parsing: runs only with EXTRACT_STRESS=1 (CI sets it).

const wrap = (b: string) => `<!doctype html><html><head><title>t</title></head><body>${b}</body></html>`;
const chain = (d: number, inner: string) => "<div>".repeat(d) + inner + "</div>".repeat(d);
const fill = (unit: string) => unit.repeat(Math.floor((MAX_HTML_BYTES - 200) / unit.length));
const PARA = "<p>" + "A long enough sentence about the council vote, with words. ".repeat(12) + "</p>";
const GOOD = wrap(`<article><h1>Vote</h1>${PARA}</article>`);

// Round 5's shapes, plus new ones found in this round. Each is served at
// https://<host>/<name>; anything not named here is GOOD.
const SHAPES: Record<string, string> = {
  ltltComment: wrap('<div class="comment">' + fill("<<") + "</div>"),
  ltlt: wrap("<p>" + fill("<<") + "</p>"),
  lt1: wrap("<p>" + fill("<1") + "</p>"),
  amp199kFlat: wrap("<div>" + "x&amp;".repeat(Math.floor(199_000 / 6)) + "</div>"),
  amp199kNested: wrap(chain(63, "x&amp;".repeat(Math.floor(199_000 / 6)))),
  ampUnclosedB: wrap("<b>x&amp;".repeat(19_900)),
  chains317x63: wrap(Array.from({ length: 317 }, () => chain(62, "x<br>")).join("")),
  closeBr3mb: wrap(fill("</br>")),
  unclosed200k: wrap("<i>".repeat(200_000)),
  div1000: wrap(chain(1000, "x")),
  div5000: wrap(chain(5000, "x")),
  // New this round.
  entities3mb: wrap("<p>" + fill("&amp;") + "</p>"),
  cdata3mb: wrap(fill("<![CDATA[x]]>")),
  emptyComments3mb: wrap(fill("<!-->")),
  nbsp3mb: wrap("<p>" + fill("&nbsp;") + "</p>"),
  attrUnique300k: wrap(`<div ${Array.from({ length: 300_000 }, (_, i) => "a" + i).join(" ")}>x</div>`),
  hugeAttrValue: wrap(`<div data-x="${"a".repeat(MAX_HTML_BYTES - 400)}">hi</div>`),
  textareaTagText: wrap("<textarea>" + fill("<a>") + "</textarea>"),
  ltSpaceA: wrap("<p>" + fill("< a") + "</p>"),
  // Only the thread's time limit stops it, on any CPU.
  slow: SLOW_PAGE,
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
      const body = SHAPES[u.pathname.slice(1)] ?? GOOD;
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    })
  );
}

/**
 * Runs `fn` while a 10 ms interval on this thread records its longest gap.
 * The bound used below is 500 ms: a page parsed on this thread holds it for
 * 1-2 s or more, and under a flood of hostile pages this thread was measured
 * pausing up to about 300 ms on its own.
 */
async function watchLoop<T>(fn: () => Promise<T>) {
  let longestGap = 0;
  let ticks = 0;
  let last = performance.now();
  const interval = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
    ticks++;
  }, 10);
  const started = performance.now();
  try {
    const value = await fn();
    return { value, ms: Math.round(performance.now() - started), gap: Math.round(longestGap), ticks };
  } finally {
    clearInterval(interval);
  }
}

const outcome = (r: ExtractResult | undefined) => (r === undefined ? "untried" : r.ok ? "ok" : r.reason);
let logs: string[];
const starts = () => logs.filter((l) => l.includes("parser thread started")).length;

beforeEach(() => {
  resetExtractStateForTests();
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  stubFetch();
  logs = [];
  const keep = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Shapes that a real page could also look like are allowed to extract; the
// rest must be refused. Either way: back inside the time limit plus slack,
// loop never held. entities3mb is one <p> of ampersands: on a fast CPU
// Readability finishes it inside PARSE_TIMEOUT_MS and returns that text, cut
// to the cap like any page's, so it may extract the way amp199kFlat does.
const MAY_EXTRACT = new Set(["amp199kFlat", "hugeAttrValue", "textareaTagText", "entities3mb"]);

describe("attack shapes through extractArticles (8 s budget, as the full report)", () => {
  it.each(Object.keys(SHAPES))("%s", async (name) => {
    const { value, ms, gap } = await watchLoop(() =>
      extractArticles([`https://a.example/${name}`], { deadline: Date.now() + 8_000 })
    );
    const got = outcome(value[0]);
    process.stdout.write(`[qa6] extractArticles ${name}: ${got} in ${ms} ms, longest loop gap ${gap} ms\n`);
    if (!MAY_EXTRACT.has(name)) expect(got).not.toBe("ok");
    expect(ms).toBeLessThan(PARSE_TIMEOUT_MS + SLOW_CPU_SLACK_MS);
    expect(gap).toBeLessThan(500);
  }, 20_000);
});

describe("attack shapes through extractForStory (15 s budget, as a digest card)", () => {
  it("a story of five hostile pages: the good fallbacks are never reached, but it returns in time and the loop stays free", async () => {
    const urls = ["ltltComment", "slow", "cdata3mb", "chains317x63", "nbsp3mb"].map((n, i) => `https://h${i}.example/${n}`);
    const { value, ms, gap } = await watchLoop(() => extractForStory(urls, { deadline: Date.now() + 15_000 }));
    process.stdout.write(`[qa6] story of 5 hostile: ${value.map(outcome).join(",")} in ${ms} ms, gap ${gap} ms\n`);
    expect(value.every((r) => r && !r.ok)).toBe(true);
    // The caller's deadline holds even though five pages could hold the
    // thread 5 x PARSE_TIMEOUT_MS.
    expect(ms).toBeLessThan(15_500);
    expect(gap).toBeLessThan(500);
  }, 30_000);

  it("a story whose first three pages are hostile falls back to its 4th and 5th, which extract", async () => {
    const urls = ["closeBr3mb", "lt1", "cdata3mb", "good", "good"].map((n, i) => `https://s${i}.example/${n}`);
    const { value, ms, gap } = await watchLoop(() => extractForStory(urls, { deadline: Date.now() + 15_000 }));
    process.stdout.write(`[qa6] fallback story: ${value.map(outcome).join(",")} in ${ms} ms, gap ${gap} ms\n`);
    expect(value.slice(0, 3).every((r) => r && !r.ok)).toBe(true);
    expect(value.slice(3).map(outcome)).toEqual(["ok", "ok"]);
    expect(gap).toBeLessThan(500);
  }, 30_000);
});

describe("many hostile pages at once (a digest's worth of cards)", () => {
  it("10 stories in parallel, each with two hostile pages: every call returns by its deadline, the loop stays free, no slot leaks", async () => {
    const hostile = ["ltltComment", "entities3mb", "cdata3mb", "closeBr3mb", "nbsp3mb", "chains317x63", "emptyComments3mb", "ltSpaceA", "lt1", "ltlt"];
    const deadline = Date.now() + 15_000;
    const stories = hostile.map((h, i) => [
      `https://x${i}.example/${h}`,
      `https://y${i}.example/${hostile[(i + 3) % hostile.length]}`,
      `https://z${i}.example/good`,
      `https://w${i}.example/good`,
      `https://v${i}.example/good`,
    ]);
    const { value, ms, gap } = await watchLoop(() =>
      Promise.all(stories.map((urls) => extractForStory(urls, { deadline })))
    );
    const flat = value.flat().map(outcome);
    const counts = flat.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
    process.stdout.write(`[qa6] 10 stories at once: ${JSON.stringify(counts)} in ${ms} ms, gap ${gap} ms, ${starts()} thread starts, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB\n`);
    expect(Date.now()).toBeLessThan(deadline + 500);
    expect(gap).toBeLessThan(500);
    // Afterwards: every slot is back, the thread works.
    const after = await extractArticles(
      Array.from({ length: MAX_CONCURRENT_PAGES * 2 }, (_, i) => `https://after${i}.example/good`),
      { deadline: Date.now() + 8_000 }
    );
    expect(after.map(outcome).every((o) => o === "ok")).toBe(true);
  }, 40_000);
});

describe("process safety at the heap cap", () => {
  const heavy = ["ltltComment", "ltlt", "closeBr3mb", "emptyComments3mb", "nbsp3mb", "ltSpaceA", "lt1"];

  it("seven heavy pages in a row, twice: each ends only the thread", async () => {
    for (let round = 0; round < 2; round++) {
      const r = await extractArticles(heavy.map((h, i) => `https://m${round}-${i}.example/${h}`), { deadline: Date.now() + 15_000 });
      process.stdout.write(`[qa6] heavy round ${round}: ${r.map(outcome).join(",")}\n`);
      // Ended by the heap cap or, on a slower CPU, by the time limit first:
      // either way a refusal.
      for (const o of r.map(outcome)) expect(["too_large", "timeout"]).toContain(o);
    }
    const oom = logs.filter((l) => l.includes("reached its memory cap")).length;
    process.stdout.write(`[qa6] memory-cap endings logged: ${oom}\n`);
    expect(process.pid).toBeGreaterThan(0);
    const [good] = await extractArticles(["https://after.example/good"], { deadline: Date.now() + 8_000 });
    expect(outcome(good)).toBe("ok");
  }, 60_000);

  // The test above can't require a heap-cap ending: which limit a heavy page
  // reaches first depends on the CPU. Here the thread's time limit is held
  // off by faking setTimeout (the thread itself runs on the real clock), so
  // the page always runs to the real cap, however slow the machine.
  it("a heap flood with the time limit held off always reaches the real cap: too_large, logged, and only the thread ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let r: ExtractResult[];
    try {
      r = await extractArticles(["https://oom.example/ltltComment"], { deadline: Date.now() + 8_000 });
    } finally {
      vi.useRealTimers();
    }
    process.stdout.write(`[qa6] heap flood, no time limit: ${outcome(r[0])}\n`);
    expect(outcome(r[0])).toBe("too_large");
    expect(logs.filter((l) => l.includes("reached its memory cap"))).toHaveLength(1);
    expect(process.pid).toBeGreaterThan(0);
    resetExtractStateForTests();
    const [good] = await extractArticles(["https://after.example/good"], { deadline: Date.now() + 8_000 });
    expect(outcome(good)).toBe("ok");
  }, 60_000);

  it("three stories of heavy pages at once", async () => {
    const deadline = Date.now() + 15_000;
    const r = await Promise.all(
      [0, 1, 2].map((s) => extractForStory(heavy.slice(s, s + 5).map((h, i) => `https://c${s}-${i}.example/${h}`), { deadline }))
    );
    process.stdout.write(`[qa6] heavy stories: ${r.map((x) => x.map(outcome).join(",")).join(" | ")}\n`);
    expect(Date.now()).toBeLessThan(deadline + 500);
    const [good] = await extractArticles(["https://after.example/good"], { deadline: Date.now() + 8_000 });
    expect(outcome(good)).toBe("ok");
  }, 60_000);
});

describe("nothing outlives a run", () => {
  const refTimers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;

  it("no ref'd timer is left after a page is stopped at its time limit, at the heap cap, or waits past the deadline", async () => {
    // Let any timer from an earlier test (a queued page's deadline) run out first.
    await new Promise((r) => setTimeout(r, 1_000));
    const before = refTimers();
    await extractArticles(["https://a.example/slow", "https://b.example/ltltComment", "https://c.example/good"], {
      deadline: Date.now() + 8_000,
    });
    // A page stuck in the queue at its deadline.
    await extractArticles(["https://d.example/slow", "https://e.example/good"], { deadline: Date.now() + 700 });
    // Give terminate() and late events a moment.
    await new Promise((r) => setTimeout(r, 600));
    expect(refTimers()).toBe(before);
  }, 30_000);

  it("the thread is ended 10 s after its last page, and the next page starts a new one", async () => {
    await extractArticles(["https://a.example/good"], { deadline: Date.now() + 8_000 });
    expect(starts()).toBe(1);
    await extractArticles(["https://b.example/good"], { deadline: Date.now() + 8_000 });
    expect(starts()).toBe(1);
    await new Promise((r) => setTimeout(r, 10_400));
    await extractArticles(["https://c.example/good"], { deadline: Date.now() + 8_000 });
    expect(starts()).toBe(2);
  }, 30_000);

  it("pages queued behind a stuck one keep their order and their own deadlines", async () => {
    // Page 1 holds the thread for PARSE_TIMEOUT_MS. Pages 2-4 wait; with a
    // 1.2 s deadline they must be timeout at 1.2 s, not at the time limit.
    const started = performance.now();
    const r = await extractArticles(
      ["https://a.example/slow", "https://b.example/good", "https://c.example/good", "https://d.example/good"],
      { deadline: Date.now() + 1_200 }
    );
    const ms = performance.now() - started;
    expect(r.map(outcome)).toEqual(["timeout", "timeout", "timeout", "timeout"]);
    expect(ms).toBeLessThan(1_450);
    // And with room, they extract in order on a fresh thread.
    const r2 = await extractArticles(
      ["https://a.example/slow", "https://b.example/good", "https://c.example/good", "https://d.example/good"],
      { deadline: Date.now() + 8_000 }
    );
    expect(r2.map(outcome)).toEqual(["timeout", "ok", "ok", "ok"]);
  }, 30_000);
});

describe("headroom for real pages", () => {
  // A big but ordinary page: about 13,600 raw tags, 25 deep.
  const big = wrap(
    `<header>${"<nav><ul>" + "<li><a href='/s'><span>Section</span></a></li>".repeat(400) + "</ul></nav>"}</header>` +
      `<main>${chain(20, `<article><h1>Big story</h1>${Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i}: officials said, on Tuesday, that the plan <a href="/x">critics</a> called <em>rushed</em> would cost billions.</p>`).join("")}</article>`)}</main>` +
      `<aside>${"<div class='rel'><a href='/r'><img src='/i.jpg'><span>Related</span></a></div>".repeat(1500)}</aside>` +
      `<script>${"var a='<div>';".repeat(5_000)}</script>`
  );

  it("a 13,600-tag page parses well inside the PARSE_TIMEOUT_MS limit", async () => {
    SHAPES.bigReal = big;
    try {
      await extractArticles(["https://warm.example/good"], { deadline: Date.now() + 8_000 });
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const { value, ms } = await watchLoop(() => extractArticles([`https://r${i}.example/bigReal`], { deadline: Date.now() + 8_000 }));
        expect(outcome(value[0])).toBe("ok");
        times.push(ms);
      }
      const tags = (big.match(/<[a-zA-Z]/g) ?? []).length;
      process.stdout.write(`[qa6] big real page (${tags} raw tags, ${big.length} bytes): ${times.join(", ")} ms\n`);
    } finally {
      delete SHAPES.bigReal;
    }
  }, 30_000);
});

describe("page slots after the thread is stopped", () => {
  it("after pages stopped at the time limit, the heap cap and the deadline, all 8 slots are free again (exactly 8 page fetches run at once)", async () => {
    await extractArticles(
      ["https://a.example/slow", "https://b.example/ltltComment", "https://c.example/entities3mb", "https://d.example/good"],
      { deadline: Date.now() + 8_000 }
    );
    await extractArticles(["https://e.example/slow", "https://f.example/good", "https://g.example/good"], { deadline: Date.now() + 800 });
    await new Promise((r) => setTimeout(r, 300));

    // Now hold every page fetch open and count how many start together.
    let inFlight = 0;
    let most = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
        inFlight++;
        most = Math.max(most, inFlight);
        await gate;
        inFlight--;
        return new Response(GOOD, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      })
    );
    const urls = Array.from({ length: MAX_CONCURRENT_PAGES + 4 }, (_, i) => `https://hold${i}.example/good`);
    const pending = extractArticles(urls, { deadline: Date.now() + 8_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(most).toBe(MAX_CONCURRENT_PAGES);
    release();
    expect((await pending).map(outcome).every((o) => o === "ok")).toBe(true);
  }, 30_000);
});
