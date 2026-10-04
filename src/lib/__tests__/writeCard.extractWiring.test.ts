import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No real DNS query: names resolve to a public address, except
// inside.example, which resolves to the cloud metadata address.
vi.mock("node:dns/promises", () => {
  const lookup = async (host: string) => [
    { address: host === "inside.example" ? "169.254.169.254" : "93.184.216.34", family: 4 },
  ];
  return { lookup, default: { lookup } };
});
import { readFileSync } from "node:fs";
import path from "node:path";
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";

// The real extraction module against a fake web: proves the writer's prompt
// carries what a real page yields, and what a refusing site doesn't.
const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

import { writeCard } from "@/lib/writeCard";
import { generateExpandedReport } from "@/lib/cards";
import { resetExtractStateForTests } from "@/lib/extract";

const ARTICLE = readFileSync(path.join(__dirname, "fixtures/extract/article.html"), "utf8");
const TOPIC = TOPICS[0] as Topic;
const [OPEN, CLOSED] = SOURCES.slice(0, 2) as Source[];

const cluster: Cluster = {
  topic: TOPIC,
  articles: [
    { title: "Open", snippet: "Open snippet", url: "https://open.example/story", source: OPEN, topic: TOPIC, publishedAt: "2026-10-02T10:00:00Z" },
    { title: "Closed", snippet: "Closed snippet", url: "https://closed.example/story", source: CLOSED, topic: TOPIC, publishedAt: "2026-10-02T11:00:00Z" },
  ],
};

beforeEach(() => {
  resetExtractStateForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockParse.mockReset();
  // The report call is the one with the larger output budget.
  mockParse.mockImplementation(async (params: { max_tokens: number }) =>
    params.max_tokens === 4096
      ? { parsed_output: { report: "A full report." }, stop_reason: "end_turn" }
      : { parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] }, stop_reason: "end_turn" }
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://open.example/robots.txt") return new Response("", { status: 404 });
      if (url === "https://open.example/story") {
        return new Response(ARTICLE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url === "https://closed.example/robots.txt") return new Response("User-agent: *\nDisallow: /\n");
      throw new Error(`unexpected fetch in test: ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writeCard and the full report with the real extractor", () => {
  it("the card is written from the open page's text; the refusing site is context and is never requested", async () => {
    const card = await writeCard(cluster, 3);
    const content = mockParse.mock.calls[0][0].messages[0].content as string;
    expect(content).toContain("Text: The city council voted on Tuesday");
    expect(content).toContain("Other coverage (headline and feed summary only):\n\nSource: " + CLOSED + "\nTitle: Closed\nClosed snippet");
    const requested = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(requested).not.toContain("https://closed.example/story");
    // The card itself carries only the RSS snippets.
    expect(card.sources.map((s) => s.snippet)).toEqual(["Open snippet", "Closed snippet"]);
    expect(JSON.stringify(card)).not.toContain("city council voted");
  });

  it("the full report re-fetches and writes from the same page", async () => {
    const report = await generateExpandedReport({
      topic: TOPIC,
      shortSummary: "Summary.",
      sources: cluster.articles.map(({ title, url, source, snippet }) => ({ title, url, source, snippet })),
    });
    const content = mockParse.mock.calls[0][0].messages[0].content as string;
    expect(content).toContain("The city council voted on Tuesday");
    expect(report).toBe("A full report.");
  });

  it("a stored source URL that points into a private network is never requested; the report uses its snippet", async () => {
    // A card row is writable by its reader, so its URLs are untrusted input.
    await generateExpandedReport({
      topic: TOPIC,
      shortSummary: "Summary.",
      sources: [{ title: "Planted", url: "http://inside.example/latest/meta-data", source: OPEN, snippet: "Planted snippet" }],
    });
    const requested = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(requested.some((u) => u.includes("inside.example"))).toBe(false);
    const content = mockParse.mock.calls[0][0].messages[0].content as string;
    expect(content).toContain("Title: Planted\nPlanted snippet");
    expect(content).not.toContain("Full-text articles");
  });
});
