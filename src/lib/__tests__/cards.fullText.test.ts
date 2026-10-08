import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SOURCES, TOPICS, type Card, type Source, type Topic } from "@/types";
import type { ExtractResult } from "@/lib/extract";

const { mockParse, mockExtract } = vi.hoisted(() => ({ mockParse: vi.fn(), mockExtract: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});
vi.mock("@/lib/extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extract")>()),
  extractForStory: mockExtract,
}));

import { generateExpandedReport } from "@/lib/cards";
import { FULL_TEXT_INSTRUCTION } from "@/lib/extract";
import { signSourceLink } from "@/lib/sourceLinks";

const SECRET = "test-source-link-secret-0123456789abcdef0123";

const TOPIC = TOPICS[0] as Topic;

function makeCard(n: number): Pick<Card, "topic" | "shortSummary" | "sources"> {
  return {
    topic: TOPIC,
    shortSummary: "The short summary.",
    sources: Array.from({ length: n }, (_, i) => ({
      title: `Title ${i}`,
      url: `https://example.com/${i}`,
      source: SOURCES[i] as Source,
      snippet: `Snippet ${i}`,
      sig: signSourceLink(`https://example.com/${i}`, SECRET),
    })),
  };
}

const textFor = (url: string) => `FULLTEXT[${url}] The article body, several sentences long.`;

function extractWith(okUrls: string[]) {
  mockExtract.mockImplementation(async (urls: readonly string[]): Promise<ExtractResult[]> =>
    urls.map((url) => (okUrls.includes(url) ? { url, ok: true, text: textFor(url) } : { url, ok: false, reason: "robots" }))
  );
}

const sentContent = () => mockParse.mock.calls[0][0].messages[0].content as string;

beforeEach(() => {
  vi.stubEnv("SOURCE_LINK_SECRET", SECRET);
  mockParse.mockReset();
  mockExtract.mockReset();
  mockParse.mockResolvedValue({ parsed_output: { report: "A full report." }, stop_reason: "end_turn" });
  extractWith([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("generateExpandedReport re-fetches the pages", () => {
  it("asks for every persisted source's page, in stored order, with an 8 s deadline", async () => {
    const before = Date.now();
    await generateExpandedReport(makeCard(7));
    const after = Date.now();
    const [urls, opts] = mockExtract.mock.calls[0];
    expect(urls).toEqual(Array.from({ length: 7 }, (_, i) => `https://example.com/${i}`));
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 8_000);
    expect(opts.deadline).toBeLessThanOrEqual(after + 8_000);
  });

  it("with every page blocked, sends exactly today's prompt", async () => {
    await generateExpandedReport(makeCard(2));
    expect(sentContent()).toBe(
      `Topic: ${TOPIC}\n\nShort summary already shown to the reader:\nThe short summary.\n\nSource material:\n` +
        `Source: ${SOURCES[0]}\nTitle: Title 0\nSnippet 0\n\nSource: ${SOURCES[1]}\nTitle: Title 1\nSnippet 1`
    );
  });

  it("writes from the pages that loaded; the rest fall back to their persisted snippet", async () => {
    extractWith(["https://example.com/2"]);
    await generateExpandedReport(makeCard(3));
    const content = sentContent();
    expect(content).toContain(`Source material:\n${FULL_TEXT_INSTRUCTION}\n\nFull-text articles:\n\nSource: ${SOURCES[2]}\nTitle: Title 2\nText: ${textFor("https://example.com/2")}`);
    const [, context] = content.split("Other coverage (headline and feed summary only):");
    expect(context).toContain("Title: Title 0\nSnippet 0");
    expect(context).toContain("Title: Title 1\nSnippet 1");
    expect(context).not.toContain("FULLTEXT[");
  });

  it("returns only the report: no extracted text reaches the caller", async () => {
    extractWith(["https://example.com/0", "https://example.com/1"]);
    const report = await generateExpandedReport(makeCard(2));
    expect(report).toBe("A full report.");
  });
});

// A card's sources come from the database, where a signed-in user can store
// any link through persist_generated_cards, so the report requests a page only
// when its link carries the server's signature.
describe("generateExpandedReport fetches only signed links", () => {
  it("never requests a link stored without a signature", async () => {
    const card = makeCard(3);
    delete card.sources[1].sig;
    await generateExpandedReport(card);
    expect(mockExtract.mock.calls[0][0]).toEqual(["https://example.com/0", "https://example.com/2"]);
  });

  it("never requests a link whose signature is forged", async () => {
    const card = makeCard(2);
    card.sources[0].sig = "AAAA";
    card.sources[1].sig = signSourceLink("https://example.com/1", "another-secret-of-sufficient-length-000000");
    await generateExpandedReport(card);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("never requests a link carrying another link's signature", async () => {
    const card = makeCard(2);
    card.sources[1] = { ...card.sources[1], url: "http://169.254.169.254/latest/meta-data/", sig: card.sources[0].sig };
    await generateExpandedReport(card);
    expect(mockExtract.mock.calls[0][0]).toEqual(["https://example.com/0"]);
  });

  it("fetches nothing and sends today's snippet prompt when no secret is configured", async () => {
    vi.stubEnv("SOURCE_LINK_SECRET", "");
    await generateExpandedReport(makeCard(2));
    expect(mockExtract).not.toHaveBeenCalled();
    expect(sentContent()).toBe(
      `Topic: ${TOPIC}\n\nShort summary already shown to the reader:\nThe short summary.\n\nSource material:\n` +
        `Source: ${SOURCES[0]}\nTitle: Title 0\nSnippet 0\n\nSource: ${SOURCES[1]}\nTitle: Title 1\nSnippet 1`
    );
  });

  it("keeps each page's text on its own source when an unsigned link sits between signed ones", async () => {
    const card = makeCard(3);
    delete card.sources[0].sig;
    extractWith(["https://example.com/2"]);
    await generateExpandedReport(card);
    const content = sentContent();
    expect(content).toContain(`Source: ${SOURCES[2]}\nTitle: Title 2\nText: ${textFor("https://example.com/2")}`);
    const [, context] = content.split("Other coverage (headline and feed summary only):");
    expect(context).toContain("Title: Title 0\nSnippet 0");
    expect(context).toContain("Title: Title 1\nSnippet 1");
  });
});
