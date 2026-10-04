import { describe, it, expect, vi, beforeEach } from "vitest";
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";
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

import { buildWriteCardContent, writeCard } from "@/lib/writeCard";
import { FULL_TEXT_INSTRUCTION, MAX_FULL_TEXTS_PER_STORY } from "@/lib/extract";

const TOPIC = TOPICS[0] as Topic;
const [PICKED, PICKED_TOO, OTHER, OTHER_TOO, FIFTH, SIXTH] = SOURCES.slice(0, 6) as Source[];

function makeCluster(sources: Source[]): Cluster {
  return {
    topic: TOPIC,
    articles: sources.map((source, i) => ({
      title: `Title ${i}`,
      snippet: `Snippet ${i}`,
      url: `https://example.com/${i}`,
      source,
      topic: TOPIC,
      publishedAt: `2026-10-02T1${i}:00:00Z`,
    })),
  };
}

/** OTHER(0), PICKED(1), OTHER_TOO(2), PICKED_TOO(3). */
const fourSources = () => makeCluster([OTHER, PICKED, OTHER_TOO, PICKED_TOO]);

const textFor = (url: string) => `FULLTEXT[${url}] The article body, several sentences long.`;

/** Extraction answers: `ok` URLs get text, every other URL is blocked. */
function extractWith(okUrls: string[]) {
  mockExtract.mockImplementation(async (urls: readonly string[]): Promise<ExtractResult[]> =>
    urls.map((url) => (okUrls.includes(url) ? { url, ok: true, text: textFor(url) } : { url, ok: false, reason: "http_403" }))
  );
}

const sentContent = (call = 0) => mockParse.mock.calls[call][0].messages[0].content as string;

beforeEach(() => {
  mockParse.mockReset();
  mockExtract.mockReset();
  mockParse.mockResolvedValue({
    parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] },
    stop_reason: "end_turn",
  });
  extractWith([]);
});

describe("writeCard with full-text extraction", () => {
  it("asks for the story's pages in preferred-first order, with a 15 s deadline from the call's start", async () => {
    const cluster = makeCluster([OTHER, PICKED, OTHER_TOO, PICKED_TOO, FIFTH, SIXTH]);
    const before = Date.now();
    await writeCard(cluster, 3, [PICKED, PICKED_TOO]);
    const after = Date.now();
    expect(mockExtract).toHaveBeenCalledTimes(1);
    const [urls, opts] = mockExtract.mock.calls[0];
    expect(urls).toEqual([1, 3, 0, 2, 4, 5].map((i) => `https://example.com/${i}`));
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 15_000);
    expect(opts.deadline).toBeLessThanOrEqual(after + 15_000);
  });

  it("a fully blocked cluster gets exactly today's snippet-only prompt", async () => {
    const preferred = [PICKED, PICKED_TOO];
    await writeCard(fourSources(), 3, preferred);
    const ordered = makeCluster([PICKED, PICKED_TOO, OTHER, OTHER_TOO]);
    ordered.articles = [1, 3, 0, 2].map((i) => fourSources().articles[i]);
    expect(sentContent()).toBe(buildWriteCardContent(ordered, preferred));
    expect(sentContent()).toBe(
      `Topic: ${TOPIC}\n\nThe reader's preferred sources for this story are listed first (${PICKED}, ${PICKED_TOO}): lead with their reporting and use the other sources to fill gaps.\n\n` +
        [1, 3, 0, 2].map((i) => `Source: ${fourSources().articles[i].source}\nTitle: Title ${i}\nSnippet ${i}`).join("\n\n")
    );
    expect(sentContent()).not.toContain(FULL_TEXT_INSTRUCTION);
  });

  it("writes from the full-text sources first; full text beats preference, preference leads among them", async () => {
    // PICKED (1) is blocked; PICKED_TOO (3) and OTHER (0) extracted.
    extractWith(["https://example.com/3", "https://example.com/0"]);
    await writeCard(fourSources(), 3, [PICKED, PICKED_TOO]);
    const content = sentContent();

    expect(content.startsWith(`Topic: ${TOPIC}\n\n${FULL_TEXT_INSTRUCTION}\n\n`)).toBe(true);
    const [material, context] = content.split("Other coverage (headline and feed summary only):");
    expect([...material.matchAll(/Title: Title (\d)/g)].map((m) => Number(m[1]))).toEqual([3, 0]);
    expect(material).toContain(`Text: ${textFor("https://example.com/3")}`);
    expect(material).toContain(`Text: ${textFor("https://example.com/0")}`);
    expect([...context.matchAll(/Title: Title (\d)/g)].map((m) => Number(m[1]))).toEqual([1, 2]);
    expect(context).toContain("Snippet 1");
    expect(context).toContain("Snippet 2");
    // The lead note names only the preferred outlet that gave full text.
    expect(content).toContain(`listed first (${PICKED_TOO}): lead with their reporting`);
    expect(content).not.toContain(`listed first (${PICKED},`);
  });

  it("drops the lead note when no preferred outlet gave full text", async () => {
    extractWith(["https://example.com/0"]);
    await writeCard(fourSources(), 3, [PICKED, PICKED_TOO]);
    expect(sentContent()).not.toContain("preferred sources");
  });

  it(`uses at most ${MAX_FULL_TEXTS_PER_STORY} full texts; extra extracted sources stay as headline context, their text unused`, async () => {
    const cluster = makeCluster([OTHER, PICKED, OTHER_TOO, PICKED_TOO, FIFTH]);
    const all = cluster.articles.map((a) => a.url);
    extractWith(all);
    await writeCard(cluster, 3);
    const content = sentContent();
    expect(content.match(/\nText: /g)).toHaveLength(MAX_FULL_TEXTS_PER_STORY);
    for (const url of all.slice(MAX_FULL_TEXTS_PER_STORY)) expect(content).not.toContain(textFor(url));
    const [, context] = content.split("Other coverage (headline and feed summary only):");
    expect([...context.matchAll(/Title: Title (\d)/g)].map((m) => Number(m[1]))).toEqual([3, 4]);
  });

  it("keeps Card.sources exactly as before: every source, preferred first, RSS snippets, no extracted text", async () => {
    extractWith(["https://example.com/3", "https://example.com/0"]);
    const card = await writeCard(fourSources(), 3, [PICKED, PICKED_TOO]);
    expect(card.sources).toEqual(
      [1, 3, 0, 2].map((i) => ({
        title: `Title ${i}`,
        url: `https://example.com/${i}`,
        source: fourSources().articles[i].source,
        snippet: `Snippet ${i}`,
      }))
    );
    expect(JSON.stringify(card)).not.toContain("FULLTEXT[");
  });

  it("extracts once even when the writer retries", async () => {
    extractWith(["https://example.com/0"]);
    mockParse
      .mockResolvedValueOnce({
        parsed_output: { title: "T", shortSummary: "Cut off mid", labels: ["Tag"] },
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] },
        stop_reason: "end_turn",
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeCard(fourSources(), 3);
    expect(mockParse).toHaveBeenCalledTimes(2);
    expect(mockExtract).toHaveBeenCalledTimes(1);
    expect(sentContent(1)).toBe(sentContent(0));
    expect(sentContent(1)).toContain(textFor("https://example.com/0"));
  });

  it("keeps the model choice on article count: a one-article cluster is still Haiku with full text", async () => {
    extractWith(["https://example.com/0"]);
    await writeCard(makeCluster([OTHER]), 2);
    expect(mockParse.mock.calls[0][0].model).toBe("claude-haiku-4-5");
    expect(sentContent()).toContain(textFor("https://example.com/0"));
    expect(sentContent()).not.toContain("Other coverage");
  });

  it("an empty cluster still fails before any page is fetched", async () => {
    await expect(writeCard({ topic: TOPIC, articles: [] }, 3)).rejects.toThrow(/no articles/);
    expect(mockExtract).not.toHaveBeenCalled();
  });
});
