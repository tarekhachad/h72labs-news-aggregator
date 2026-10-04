import { describe, it, expect, vi, beforeEach } from "vitest";

// Every page "blocked": the writer gets exactly the snippet-only prompt, and
// nothing in this file can reach the live web.
vi.mock("@/lib/extract", async (importOriginal) => {
  const blocked = async (urls: readonly string[]) =>
    urls.map((url) => ({ url, ok: false as const, reason: "robots" as const }));
  return {
    ...(await importOriginal<typeof import("@/lib/extract")>()),
    extractArticles: blocked,
    extractForStory: blocked,
  };
});
import type { Cluster } from "@/types";
import { QUOTATION_STYLE } from "@/lib/claudeText";

// Both prose-writing call sites return their text inside a structured-output
// JSON string, so both must carry the rule that keeps a bare `"` out of it.
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

const cluster: Cluster = {
  topic: "Football",
  articles: [
    {
      title: "A title",
      snippet: "A snippet",
      url: "https://example.com/a",
      source: "BBC",
      topic: "Football",
      publishedAt: "2026-09-28T12:00:00Z",
    },
  ],
};

beforeEach(() => {
  mockParse.mockReset();
});

describe("quotation style in prose prompts", () => {
  it("writeCard sends the quotation rule in its system prompt", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { title: "T", shortSummary: "He called it “a bad day.”", labels: ["Tag"] },
      stop_reason: "end_turn",
    });
    const { writeCard } = await import("@/lib/writeCard");

    const card = await writeCard(cluster, 3);

    expect(mockParse.mock.calls[0][0].system).toContain(QUOTATION_STYLE);
    expect(card.shortSummary).toBe("He called it “a bad day.”");
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it("generateExpandedReport sends the quotation rule in its system prompt", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { report: "He called it “a bad day.”" },
      stop_reason: "end_turn",
    });
    const { generateExpandedReport } = await import("@/lib/cards");

    const report = await generateExpandedReport({
      topic: "Football",
      shortSummary: "A summary.",
      sources: [{ title: "A title", url: "https://example.com/a", source: "BBC", snippet: "A snippet" }],
    });

    expect(mockParse.mock.calls[0][0].system).toContain(QUOTATION_STYLE);
    expect(report).toBe("He called it “a bad day.”");
    expect(mockParse).toHaveBeenCalledTimes(1);
  });
});
