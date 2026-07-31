import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Article } from "@/types";

// This file exists to verify one specific fix applied after code review:
// clusterText() in dedup.ts now truncates each article's snippet to 200
// chars before concatenating (SNIPPET_CHARS_PER_ARTICLE), where it
// previously concatenated the full, unbounded snippet. clusterText() itself
// isn't exported, so this drives it indirectly through filterAlreadyCovered
// and inspects the actual text handed to embed() and to the Anthropic call
// (via isSameStory) — the two real consumers of clusterText()'s output.

const mockEmbed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return {
    ...actual,
    embed: mockEmbed,
    // Both cluster and card vectors are identical [1,0] -> cosine similarity
    // 1, which clears the dup-candidate gate every time, guaranteeing the
    // Haiku call (and hence the embed() call) actually happens in every test
    // below regardless of the (irrelevant, for this test) text content.
    cosineSimilarity: actual.cosineSimilarity,
  };
});

const mockParse = vi.fn(async (_params: { messages: { content: string }[] }) => ({
  parsed_output: { sameStory: false },
}));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    title: "A title",
    snippet: "A snippet",
    url: "https://example.com/a",
    source: "BBC",
    topic: "Tech/AI",
    publishedAt: "2026-07-31T12:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockEmbed.mockClear();
  mockParse.mockClear();
});

describe("clusterText snippet truncation (via filterAlreadyCovered)", () => {
  it("truncates a long snippet to 200 chars before it reaches embed()", async () => {
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    // First 200 chars are all "A"s (so we can assert on exact slice length);
    // TAIL_MARKER sits well past the 200-char cutoff and must not survive
    // truncation.
    const longSnippet = "A".repeat(200) + "TAIL_MARKER_SHOULD_BE_CUT";
    const cluster: Cluster = {
      topic: "Tech/AI",
      articles: [makeArticle({ title: "T", snippet: longSnippet })],
    };

    await filterAlreadyCovered(
      [cluster],
      [{ topic: "Tech/AI", shortSummary: "existing summary, irrelevant content" }]
    );

    expect(mockEmbed).toHaveBeenCalled();
    // First embed() call is for the cluster texts (see dedup.ts: embed is
    // called via Promise.all([embed(clusterTexts), embed(cardTexts)])) —
    // both calls happen, so just search every text passed to embed() across
    // all calls for the marker instead of relying on call order.
    const allEmbeddedTexts = mockEmbed.mock.calls.flatMap(([texts]) => texts);
    const clusterEmbeddedText = allEmbeddedTexts.find((t) => t.startsWith("T. "));

    expect(clusterEmbeddedText).toBeDefined();
    expect(clusterEmbeddedText).not.toContain("TAIL_MARKER_SHOULD_BE_CUT");
    // "T. " (title + separator) + 200 chars of "A" = 3 + 200 = 203 total.
    expect(clusterEmbeddedText!.length).toBe(203);
  });

  it("truncates a long snippet before it reaches the Anthropic (Haiku) call", async () => {
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    const longSnippet = "HEAD" + "A".repeat(196) + "TAIL_MARKER_SHOULD_BE_CUT";
    const cluster: Cluster = {
      topic: "Tech/AI",
      articles: [makeArticle({ title: "T", snippet: longSnippet })],
    };

    await filterAlreadyCovered(
      [cluster],
      [{ topic: "Tech/AI", shortSummary: "existing summary, irrelevant content" }]
    );

    expect(mockParse).toHaveBeenCalledTimes(1);
    const sentContent = mockParse.mock.calls[0][0].messages[0].content;

    expect(sentContent).toContain("HEAD");
    expect(sentContent).not.toContain("TAIL_MARKER_SHOULD_BE_CUT");
  });

  it("does not truncate a short snippet (well under 200 chars)", async () => {
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    const shortSnippet = "a short snippet under the cap";
    const cluster: Cluster = {
      topic: "Tech/AI",
      articles: [makeArticle({ title: "T", snippet: shortSnippet })],
    };

    await filterAlreadyCovered(
      [cluster],
      [{ topic: "Tech/AI", shortSummary: "existing summary, irrelevant content" }]
    );

    const sentContent = mockParse.mock.calls[0][0].messages[0].content;
    expect(sentContent).toContain(shortSnippet);
  });
});
