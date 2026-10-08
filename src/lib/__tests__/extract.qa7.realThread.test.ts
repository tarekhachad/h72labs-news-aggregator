import { it, expect, vi, beforeEach, afterEach } from "vitest";

// QA round 7: the REAL parser thread and the heavy-host rule, against rounds
// 5 and 6's attack shapes served by one outlet, redirects into it, subdomain
// evasion, and how close a legitimate page comes to the PARSE_TIMEOUT_MS
// limit on a cold thread. Synthetic HTML, fake fetch, mocked DNS, no network.
// Minutes of real parsing: runs only with EXTRACT_STRESS=1 (CI sets it).
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
import { extractArticles, extractForStory, MAX_HTML_BYTES, PARSE_TIMEOUT_MS, resetExtractStateForTests, type ExtractResult } from "@/lib/extract";
import { describeStress as describe, SLOW_CPU_SLACK_MS, SLOW_PAGE } from "./helpers/parseTiming";

const wrap = (b: string) => `<!doctype html><html><head><title>t</title></head><body>${b}</body></html>`;
const chain = (d: number, inner: string) => "<div>".repeat(d) + inner + "</div>".repeat(d);
const fill = (unit: string) => unit.repeat(Math.floor((MAX_HTML_BYTES - 200) / unit.length));
const PARA = "<p>" + "A long enough sentence about the council vote, with words. ".repeat(12) + "</p>";
const GOOD = wrap(`<article><h1>Vote</h1>${PARA}</article>`);

const SHAPES: Record<string, string> = {
  ltltComment: wrap('<div class="comment">' + fill("<<") + "</div>"),
  ltlt: wrap("<p>" + fill("<<") + "</p>"),
  lt1: wrap("<p>" + fill("<1") + "</p>"),
  amp199kNested: wrap(chain(63, "x&amp;".repeat(Math.floor(199_000 / 6)))),
  ampUnclosedB: wrap("<b>x&amp;".repeat(19_900)),
  chains317x63: wrap(Array.from({ length: 317 }, () => chain(62, "x<br>")).join("")),
  closeBr3mb: wrap(fill("</br>")),
  unclosed200k: wrap("<i>".repeat(200_000)),
  div5000: wrap(chain(5000, "x")),
  entities3mb: wrap("<p>" + fill("&amp;") + "</p>"),
  cdata3mb: wrap(fill("<![CDATA[x]]>")),
  emptyComments3mb: wrap(fill("<!-->")),
  nbsp3mb: wrap("<p>" + fill("&nbsp;") + "</p>"),
  attrUnique300k: wrap(`<div ${Array.from({ length: 300_000 }, (_, i) => "a" + i).join(" ")}>x</div>`),
  ltSpaceA: wrap("<p>" + fill("< a") + "</p>"),
};

// A realistic big page: about 13,600 raw tags, 25 deep (from round 6).
const BIG_REAL = wrap(
  `<header>${"<nav><ul>" + "<li><a href='/s'><span>Section</span></a></li>".repeat(400) + "</ul></nav>"}</header>` +
    `<main>${chain(20, `<article><h1>Big story</h1>${Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i}: officials said, on Tuesday, that the plan <a href="/x">critics</a> called <em>rushed</em> would cost billions.</p>`).join("")}</article>`)}</main>` +
    `<aside>${"<div class='rel'><a href='/r'><img src='/i.jpg'><span>Related</span></a></div>".repeat(1500)}</aside>` +
    `<script>${"var a='<div>';".repeat(5_000)}</script>`
);
// Just inside both element limits: about 19,800 tags, 30 deep, with real text.
const NEAR_LIMIT = wrap(
  `<header>${"<nav><ul>" + "<li><a href='/s'><span>Section</span></a></li>".repeat(1200) + "</ul></nav>"}</header>` +
    `<main>${chain(25, `<article><h1>Big story</h1>${Array.from({ length: 1500 }, (_, i) => `<p>Paragraph ${i}: officials said the plan <a href="/x">critics</a> called <em>rushed</em> would cost billions.</p>`).join("")}</article>`)}</main>` +
    `<aside>${"<div class='rel'><a href='/r'><img src='/i.jpg'><span>Related</span></a></div>".repeat(2000)}</aside>`
);

// At the raw-tag ceiling (about 19,900 tags), div-heavy like a CMS layout: every
// block a scored candidate for Readability.
const AT_LIMIT = wrap(
  `<main>${chain(28, `<article><h1>Big story</h1>${Array.from({ length: 2400 }, (_, i) => `<div class="para"><p>Paragraph ${i}: officials said the plan <a href="/x">critics</a> called rushed would cost billions, and more.</p></div>`).join("")}</article>`)}</main>` +
    `<aside>${"<div class='rel'><div><a href='/r'><span>Related</span></a></div></div>".repeat(2870)}</aside>`
);

let redirects: Map<string, string>;
let pageRequests: string[];

beforeEach(() => {
  resetExtractStateForTests();
  redirects = new Map();
  pageRequests = [];
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(href);
      if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
      const to = redirects.get(href);
      if (to) return new Response(null, { status: 302, headers: { location: to } });
      pageRequests.push(href);
      const name = u.pathname.slice(1).replace(/-\d+$/, "");
      const body =
        name === "bigReal" ? BIG_REAL : name === "nearLimit" ? NEAR_LIMIT : name === "atLimit" ? AT_LIMIT : name === "slow" ? SLOW_PAGE : name === "heavy" ? SHAPES.ltltComment : (SHAPES[name] ?? GOOD);
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    })
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function watchLoop<T>(fn: () => Promise<T>) {
  let longestGap = 0;
  let last = performance.now();
  const interval = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
  }, 10);
  const started = performance.now();
  try {
    const value = await fn();
    return { value, ms: Math.round(performance.now() - started), gap: Math.round(longestGap) };
  } finally {
    clearInterval(interval);
  }
}

const outcome = (r: ExtractResult | undefined) => (r === undefined ? "untried" : r.ok ? "ok" : r.reason);
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});

describe("one hostile outlet across ten stories (round 6's finding), variants", () => {
  it("served through redirects from ten different start hosts: the final host is marked, so good pages still all extract", async () => {
    const stories = Array.from({ length: 10 }, (_, i) => {
      redirects.set(`https://ra${i}.example/x`, `https://bad.example/slow-${i}`);
      redirects.set(`https://rb${i}.example/x`, `https://bad.example/heavy-${i}`);
      return [`https://ra${i}.example/x`, `https://rb${i}.example/x`, `https://g${i}.example/good`, `https://h${i}.example/good`, `https://k${i}.example/good`];
    });
    const deadline = Date.now() + 15_000;
    const { value, ms, gap } = await watchLoop(() => Promise.all(stories.map((u) => extractForStory(u, { deadline }))));
    const good = value.flatMap((r) => r.slice(2)).filter((x) => x?.ok).length;
    const badReq = pageRequests.filter((h) => h.startsWith("https://bad.example/")).length;
    process.stdout.write(`[qa7] redirected bad outlet: ${good}/30 good in ${ms} ms, gap ${gap} ms, ${badReq} page requests to bad.example, hostile: ${JSON.stringify(tally(value.flatMap((r) => r.slice(0, 2)).map(outcome)))}\n`);
    expect(good).toBe(30);
    expect(Date.now()).toBeLessThan(deadline + 500);
    expect(gap).toBeLessThan(500);
  }, 30_000);

  it("served from a fresh subdomain per page (wildcard DNS): the rule does not see it (measured, known class)", async () => {
    const stories = Array.from({ length: 10 }, (_, i) => [
      `https://s${i}.bad.example/slow-${i}`,
      `https://t${i}.bad.example/heavy-${i}`,
      `https://g${i}.example/good`,
      `https://h${i}.example/good`,
      `https://k${i}.example/good`,
    ]);
    const deadline = Date.now() + 15_000;
    const { value, ms, gap } = await watchLoop(() => Promise.all(stories.map((u) => extractForStory(u, { deadline }))));
    const good = value.flatMap((r) => r.slice(2)).filter((x) => x?.ok).length;
    process.stdout.write(`[qa7] subdomain-evading bad outlet: ${good}/30 good in ${ms} ms, gap ${gap} ms\n`);
    expect(Date.now()).toBeLessThan(deadline + 500);
    expect(gap).toBeLessThan(500);
  }, 30_000);

  it("every round-5/6 attack shape from ONE outlet, two per story, ten stories: good pages extract, deadline kept, loop free", async () => {
    const names = Object.keys(SHAPES);
    const stories = Array.from({ length: 10 }, (_, i) => [
      `https://bad.example/${names[i % names.length]}`,
      `https://bad.example/${names[(i + 5) % names.length]}`,
      `https://g${i}.example/good`,
      `https://h${i}.example/good`,
      `https://k${i}.example/good`,
    ]);
    const deadline = Date.now() + 15_000;
    const { value, ms, gap } = await watchLoop(() => Promise.all(stories.map((u) => extractForStory(u, { deadline }))));
    const good = value.flatMap((r) => r.slice(2)).filter((x) => x?.ok).length;
    process.stdout.write(`[qa7] all shapes, one outlet: ${good}/30 good in ${ms} ms, gap ${gap} ms, hostile: ${JSON.stringify(tally(value.flatMap((r) => r.slice(0, 2)).map(outcome)))}\n`);
    expect(good).toBe(30);
    expect(Date.now()).toBeLessThan(deadline + 500);
    expect(gap).toBeLessThan(500);
  }, 30_000);

  it("the same through the full report's 8 s budget: one story of five hostile pages from one outlet returns in time", async () => {
    // "slow", not chains317x63: on a fast CPU that page can finish just inside
    // PARSE_TIMEOUT_MS, which marks nothing, and the next page would then
    // cost a second limit.
    const urls = ["ltltComment", "slow", "nbsp3mb", "cdata3mb", "good"].map((n) => `https://bad.example/${n}`);
    const { value, ms, gap } = await watchLoop(() => extractForStory(urls, { deadline: Date.now() + 8_000 }));
    process.stdout.write(`[qa7] expand, one outlet: ${value.map(outcome).join(",")} in ${ms} ms, gap ${gap} ms\n`);
    expect(ms).toBeLessThan(8_500);
    expect(gap).toBeLessThan(500);
    // After the first stop, the outlet's other pages cost nothing.
    expect(ms).toBeLessThan(PARSE_TIMEOUT_MS + SLOW_CPU_SLACK_MS);
  }, 20_000);
});

describe(`how close a legitimate page comes to the PARSE_TIMEOUT_MS (${PARSE_TIMEOUT_MS} ms) limit (a miss marks the outlet heavy for 10 min)`, () => {
  it.each(["bigReal", "nearLimit", "atLimit"])("%s on a cold thread, then warm", async (name) => {
    const body = name === "bigReal" ? BIG_REAL : name === "nearLimit" ? NEAR_LIMIT : AT_LIMIT;
    const tags = (body.match(/<[a-zA-Z]/g) ?? []).length;
    const times: string[] = [];
    for (let i = 0; i < 3; i++) {
      // A fresh thread each time: the first page after a stop or an idle end.
      resetExtractStateForTests();
      const cold = await watchLoop(() => extractArticles([`https://c${i}.example/${name}`], { deadline: Date.now() + 8_000 }));
      const warm = await watchLoop(() => extractArticles([`https://w${i}.example/${name}`], { deadline: Date.now() + 8_000 }));
      times.push(`cold ${outcome(cold.value[0])} ${cold.ms} ms / warm ${outcome(warm.value[0])} ${warm.ms} ms`);
      expect(outcome(cold.value[0])).toBe("ok");
    }
    process.stdout.write(`[qa7] ${name} (${tags} raw tags, ${body.length} bytes): ${times.join("; ")}\n`);
  }, 60_000);
});
