import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// QA (v2.6.3): signature edge cases, and the full report's alignment when
// unsigned links sit between signed ones under extractForStory's real
// 5-page / 3-full-text limits (real extract.ts against a fake web).

vi.mock("node:dns/promises", () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  return { lookup, default: { lookup } };
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { SOURCES, TOPICS, type Card, type Source, type Topic } from "@/types";

const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

import { signSourceLink, verifySourceLink } from "@/lib/sourceLinks";
import { generateExpandedReport } from "@/lib/cards";
import { resetExtractStateForTests } from "@/lib/extract";

const ARTICLE = readFileSync(path.join(__dirname, "fixtures/extract/article.html"), "utf8");
const SECRET = "qa-source-link-secret-0123456789abcdef01234567";
const TOPIC = TOPICS[0] as Topic;
const SRC = SOURCES.slice(0, 10) as Source[];

describe("verifySourceLink edge cases (QA)", () => {
  const url = "https://example.com/a";
  const sig = signSourceLink(url, SECRET);

  it("is 43 base64url characters", () => {
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never throws on non-string or odd-length signatures", () => {
    for (const bad of [null, undefined, 0, 1, true, {}, [], [sig], { toString: () => sig }, Buffer.from(sig)]) {
      expect(() => verifySourceLink(url, bad, SECRET)).not.toThrow();
      expect(verifySourceLink(url, bad, SECRET)).toBe(false);
    }
  });

  it("refuses a multi-byte signature with the same character count, without throwing", () => {
    const sameChars = `é${sig.slice(1)}`; // 43 chars, 44 bytes
    expect(() => verifySourceLink(url, sameChars, SECRET)).not.toThrow();
    expect(verifySourceLink(url, sameChars, SECRET)).toBe(false);
  });

  it("refuses a multi-byte signature with the same byte count", () => {
    const sameBytes = `é${sig.slice(2)}`; // 42 chars, 43 bytes
    expect(Buffer.byteLength(sameBytes)).toBe(43);
    expect(verifySourceLink(url, sameBytes, SECRET)).toBe(false);
  });

  it("refuses a signature differing only in its last character, and the standard-base64 padded form", () => {
    const last = sig.at(-1) === "A" ? "B" : "A";
    expect(verifySourceLink(url, sig.slice(0, -1) + last, SECRET)).toBe(false);
    expect(verifySourceLink(url, `${sig}=`, SECRET)).toBe(false);
  });

  it("is bound to the label: a bare HMAC of the URL does not verify", async () => {
    const { createHmac } = await import("node:crypto");
    const bare = createHmac("sha256", SECRET).update(url).digest("base64url");
    expect(verifySourceLink(url, bare, SECRET)).toBe(false);
  });

  it("a url with a newline cannot borrow another link's signature via the label separator", () => {
    // LABEL\nurl: no url can collide with a different label because the label is fixed.
    expect(verifySourceLink("https://example.com/a\n", sig, SECRET)).toBe(false);
  });
});

// Pages on bad.example refuse via robots.txt; every other host serves the article.
function fakeWeb() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.pathname === "/robots.txt") {
      return u.hostname === "bad.example" ? new Response("User-agent: *\nDisallow: /\n") : new Response("", { status: 404 });
    }
    return new Response(ARTICLE, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

const pageRequests = () =>
  vi
    .mocked(fetch)
    .mock.calls.map((c) => String(c[0]))
    .filter((u) => !u.endsWith("/robots.txt"));

function card(spec: { host: string; signed: boolean }[]): Pick<Card, "topic" | "shortSummary" | "sources"> {
  return {
    topic: TOPIC,
    shortSummary: "The short summary.",
    sources: spec.map(({ host, signed }, i) => {
      const url = `https://${host}/story-${i}`;
      return { title: `Title ${i}`, url, source: SRC[i], snippet: `Snippet ${i}`, ...(signed ? { sig: signSourceLink(url, SECRET) } : {}) };
    }),
  };
}

const prompt = () => mockParse.mock.calls[0][0].messages[0].content as string;
const fullTextTitles = () => [...prompt().matchAll(/Title: (Title \d+)\nText: /g)].map((m) => m[1]);

describe("generateExpandedReport alignment under the real extractor's limits (QA)", () => {
  beforeEach(() => {
    vi.stubEnv("SOURCE_LINK_SECRET", SECRET);
    resetExtractStateForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockParse.mockReset();
    mockParse.mockResolvedValue({ parsed_output: { report: "A full report." }, stop_reason: "end_turn" });
    vi.stubGlobal("fetch", fakeWeb());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("interleaved unsigned links: text lands on the signed sources it came from, with the fallback", async () => {
    // signed: 1 (refuses), 3, 5, 7 (fallback), 8, 9; unsigned: 0, 2, 4, 6.
    const c = card([
      { host: "u0.example", signed: false },
      { host: "bad.example", signed: true },
      { host: "u2.example", signed: false },
      { host: "s3.example", signed: true },
      { host: "u4.example", signed: false },
      { host: "s5.example", signed: true },
      { host: "u6.example", signed: false },
      { host: "s7.example", signed: true },
      { host: "s8.example", signed: true },
      { host: "s9.example", signed: true },
    ]);
    await generateExpandedReport(c);
    expect(pageRequests()).toEqual([
      "https://s3.example/story-3",
      "https://s5.example/story-5",
      "https://s7.example/story-7",
    ]);
    expect(fullTextTitles()).toEqual(["Title 3", "Title 5", "Title 7"]);
    const [, context] = prompt().split("Other coverage (headline and feed summary only):");
    for (const i of [0, 1, 2, 4, 6, 8, 9]) expect(context).toContain(`Title: Title ${i}\nSnippet ${i}`);
  });

  it("the 5-page limit counts signed links only: unsigned ones never use up a page", async () => {
    // Signed: 1,2,4,5 refuse, 7 is the 5th signed and loads, 9 is the 6th and is never tried.
    const c = card([
      { host: "u0.example", signed: false },
      { host: "bad.example", signed: true },
      { host: "bad.example", signed: true },
      { host: "u3.example", signed: false },
      { host: "bad.example", signed: true },
      { host: "bad.example", signed: true },
      { host: "u6.example", signed: false },
      { host: "s7.example", signed: true },
      { host: "u8.example", signed: false },
      { host: "s9.example", signed: true },
    ]);
    await generateExpandedReport(c);
    expect(pageRequests()).toEqual(["https://s7.example/story-7"]);
    expect(fullTextTitles()).toEqual(["Title 7"]);
  });
});
