import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Does the parse guard bound the synchronous parse, and does
// it leave real-looking pages alone? Synthetic HTML only, served by a fake fetch.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup, default: { lookup: mockLookup } }));
import { extractArticles, MAX_HTML_BYTES, PARSE_TIMEOUT_MS, resetExtractStateForTests } from "@/lib/extract";
import { SLOW_CPU_SLACK_MS } from "./helpers/parseTiming";

function serveOne(url: string, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u === url) return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      throw new Error(`unexpected fetch in test: ${u}`);
    })
  );
}

async function timed(body: string) {
  const url = "https://site.example/a";
  serveOne(url, body);
  const started = performance.now();
  const [r] = await extractArticles([url], { deadline: Date.now() + 120_000 });
  return { r, ms: Math.round(performance.now() - started) };
}

const wrap = (b: string) => `<!doctype html><html><head><title>t</title></head><body>${b}</body></html>`;
const chain = (d: number, inner: string) => "<div>".repeat(d) + inner + "</div>".repeat(d);
const fill = (unit: string) => unit.repeat(Math.floor((MAX_HTML_BYTES - 200) / unit.length));

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

/**
 * A news-like page: header nav, article of `paras` paragraphs nested `depth`
 * deep, related-links sidebar, footer, JSON-LD and a state blob that embeds
 * the article HTML raw (the way some CMSs do), plus an SVG icon sprite.
 */
function realistic({ paras = 12, depth = 20, related = 40, sprite = 150, blobCopies = 1 } = {}) {
  const body = Array.from(
    { length: paras },
    (_, i) => `<p>Paragraph ${i}: officials said on Tuesday that the plan, which <a href="/x${i}">critics</a> called <em>rushed</em>, would cost 3 &lt; 4 billion &amp; take years.</p>`
  ).join("\n");
  const wrapDepth = Math.max(0, depth - 8);
  const article = `<article><h1>Headline here</h1><p class="byline">By A Reporter</p>${body}</article>`;
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", articleBody: body })}</script>`;
  const state = `<script>window.__STATE__=${JSON.stringify({ content: Array(blobCopies).fill(article) })};</script>`;
  const svg = `<svg style="display:none">${Array.from({ length: sprite }, (_, i) => `<symbol id="i${i}"><path d="M0 0L${i} ${i}Z"/></symbol>`).join("")}</svg>`;
  const nav = `<header><nav><ul>${Array.from({ length: 30 }, (_, i) => `<li><a href="/s${i}"><span>Section ${i}</span></a></li>`).join("")}</ul></nav></header>`;
  const side = `<aside class="sidebar"><ul>${Array.from({ length: related }, (_, i) => `<li><a href="/r${i}"><img src="/t${i}.jpg" alt=""><span>Related story ${i}</span></a></li>`).join("")}</ul></aside>`;
  const footer = `<footer>${Array.from({ length: 40 }, (_, i) => `<a href="/f${i}">Footer ${i}</a>`).join(" ")}</footer>`;
  return `<!doctype html><html><head><title>Headline</title>${jsonLd}${state}</head><body>${svg}${nav}<main>${"<div>".repeat(wrapDepth)}${article}${"</div>".repeat(wrapDepth)}</main>${side}${footer}</body></html>`;
}
const rawTags = (h: string) => (h.match(/<[a-zA-Z]/g) ?? []).length;

describe("real-looking pages are not refused", () => {
  it.each([
    ["~500 tags, 15 deep", { paras: 12, depth: 15, related: 30, sprite: 60 }],
    ["~1,000 tags, 22 deep", { paras: 20, depth: 22, related: 60, sprite: 160 }],
    ["~2,000 tags, 30 deep", { paras: 40, depth: 30, related: 120, sprite: 400 }],
    ["~4,000 tags, 30 deep, article embedded 20x in a script", { paras: 40, depth: 30, related: 120, sprite: 400, blobCopies: 20 }],
  ])("%s extracts", async (_label, opts) => {
    const page = realistic(opts);
    const { r, ms } = await timed(page);
    console.info(`[qa] ${_label}: raw tags ${rawTags(page)}, ${page.length} bytes, ${ms} ms, ${r.ok ? "ok" : r.reason}`);
    expect(r.ok ? "ok" : r.reason).toBe("ok");
    expect(r.ok && r.text).toContain("officials said on Tuesday");
  });

  it("a page nested exactly 64 below <html> extracts; 65 is refused", async () => {
    // html > body > 62 divs > p = 64 levels below <html> for the p.
    const p = "<p>" + "A long enough sentence about the council vote, with words. ".repeat(6) + "</p>";
    const at = await timed(wrap(chain(62, p)));
    const over = await timed(wrap(chain(63, p)));
    expect(at.r.ok ? "ok" : at.r.reason).toBe("ok");
    expect(over.r.ok ? "ok" : over.r.reason).toBe("too_large");
  });

  it("exactly 20,000 raw tag starts passes the pre-parse count; 20,001 is refused", async () => {
    // The html/head/title/body wrapper contributes 4 tag starts.
    const para = "<p>" + "A long enough sentence about the council vote, with words. ".repeat(6) + "</p>";
    const page = (n: number) => wrap(para + "<b>x</b>".repeat(n - 5));
    expect(rawTags(page(20_000))).toBe(20_000);
    const ok = await timed(page(20_000));
    const over = await timed(page(20_001));
    expect(ok.r.ok ? "ok" : ok.r.reason).toBe("ok");
    expect(over.r.ok ? "ok" : over.r.reason).toBe("too_large");
  });
});

// These run in the parser thread, which is stopped at its time or memory
// limit, so each must come back, refused or not, inside that limit plus slack.
describe("worst pages under both limits come back within PARSE_TIMEOUT_MS", () => {
  it.each([
    ["317 chains of 63 nested divs, 'x<br>' leaves (~20k tags, 64 deep)", wrap(Array.from({ length: 317 }, () => chain(62, "x<br>")).join(""))],
    ["3 MB of '<<' text (5 elements, ~1.5M text nodes)", wrap("<p>" + fill("<<") + "</p>")],
    ["3 MB of '<1' text", wrap("<p>" + fill("<1") + "</p>")],
    ["3 MB of '<<' inside div.comment (Readability retries every pass)", wrap('<div class="comment">' + fill("<<") + "</div>")],
    ["3 MB of '</br>' (no '<[a-zA-Z]', ~630k elements)", wrap(fill("</br>"))],
  ])("%s", async (_label, page) => {
    const { r, ms } = await timed(page);
    console.info(`[qa] ${_label}: ${ms} ms, ${r.ok ? "ok" : r.reason}`);
    expect(ms).toBeLessThan(PARSE_TIMEOUT_MS + SLOW_CPU_SLACK_MS);
  }, 20_000);
});

describe("the full report's 8 s budget holds against a text-node flood", () => {
  it("returns within 8 s + 1 s", async () => {
    const url = "https://site.example/a";
    serveOne(url, wrap('<div class="comment">' + fill("<<") + "</div>"));
    const started = performance.now();
    const [r] = await extractArticles([url], { deadline: Date.now() + 8_000 });
    const ms = Math.round(performance.now() - started);
    console.info(`[qa] 8 s deadline, text-node flood: returned after ${ms} ms as ${r.ok ? "ok" : r.reason}`);
    expect(ms).toBeLessThan(9_000);
  });
});

describe("each guard is load-bearing", () => {
  // Without the raw count, linkedom alone takes over 10 s on this 600 KB page.
  it("200,000 unclosed tags are refused before the parse", async () => {
    const { r, ms } = await timed(wrap("<i>".repeat(200_000)));
    expect(r.ok ? "ok" : r.reason).toBe("too_large");
    expect(ms).toBeLessThan(1_000);
  });

  // '</br>' makes an element without a '<' + letter, so the raw count misses
  // these ~630,000 elements; the parser thread's memory cap or the post-parse
  // count refuses them before Readability runs. On a slow CPU the parse can
  // run past the thread's time limit first, which refuses the page too.
  it("3 MB of '</br>' is refused after the parse, before Readability", async () => {
    const { r, ms } = await timed(wrap(fill("</br>")));
    expect(["too_large", "timeout"]).toContain(r.ok ? "ok" : r.reason);
    expect(ms).toBeLessThan(PARSE_TIMEOUT_MS + SLOW_CPU_SLACK_MS);
  }, 60_000);

  // Small enough to parse well inside the thread's memory, so only the
  // post-parse element count refuses it.
  it("25,000 '</br>' elements (no raw tag starts) are refused by the element count", async () => {
    const para = "<p>" + "A long enough sentence about the council vote, with words. ".repeat(6) + "</p>";
    const { r } = await timed(wrap(para + "</br>".repeat(25_000)));
    expect(r.ok ? "ok" : r.reason).toBe("too_large");
  });

  it("19,000 '</br>' elements are under the count and extract", async () => {
    const para = "<p>" + "A long enough sentence about the council vote, with words. ".repeat(6) + "</p>";
    const { r } = await timed(wrap(para + "</br>".repeat(19_000)));
    expect(r.ok ? "ok" : r.reason).toBe("ok");
  });
});

describe("the server's event loop stays free while a hostile page is parsed", () => {
  it("a 20 ms interval keeps firing through a text-node flood", async () => {
    let ticks = 0;
    let longestGap = 0;
    let last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
      ticks++;
    }, 20);
    try {
      const { r, ms } = await timed(wrap('<div class="comment">' + fill("<<") + "</div>"));
      console.info(`[qa] loop during a hostile parse: ${ticks} ticks in ${ms} ms, longest gap ${Math.round(longestGap)} ms, ${r.ok ? "ok" : r.reason}`);
      expect(r.ok).toBe(false);
      // Parsed on this thread, the same page gave 0 ticks in 6 s or more.
      expect(ticks).toBeGreaterThanOrEqual(Math.floor(ms / 20 / 4));
      expect(longestGap).toBeLessThan(500);
    } finally {
      clearInterval(interval);
    }
  });
});
