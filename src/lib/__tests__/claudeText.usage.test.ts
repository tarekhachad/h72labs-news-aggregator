import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import type { Cluster } from "@/types";

// The retry double-count guard.
//
// `generateWithRetryOnAmbiguousTruncation` calls its generator a SECOND time
// when output looks truncated but stop_reason says end_turn. Both attempts
// are billed, and on a Sonnet call at max_tokens 2048 that is the single
// most expensive event in the pipeline. Counting only the winning attempt
// would under-report exactly where it hurts most — and on the retry-then-
// fail path, which throws, a return value could carry nothing out at all.
//
// This works because `recordCall` sits INSIDE generateSummary, so it fires
// per attempt rather than per writeCard. That placement is the whole design;
// these tests are what pin it.

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

const AT = new Date("2026-08-13T12:00:00Z");

function usage(inputTokens: number) {
  return {
    input_tokens: inputTokens,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

/** A response whose shortSummary has no terminal punctuation, so it reads as truncated. */
function truncated(inputTokens: number) {
  return {
    parsed_output: { title: "A Headline", shortSummary: "This looks cut off", labels: ["Tag"] },
    stop_reason: "end_turn",
    usage: usage(inputTokens),
  };
}

function complete(inputTokens: number) {
  return {
    parsed_output: { title: "A Headline", shortSummary: "This one is complete.", labels: ["Tag"] },
    stop_reason: "end_turn",
    usage: usage(inputTokens),
  };
}

function makeCluster(): Cluster {
  return {
    topic: "Tech/AI",
    articles: [
      {
        title: "A title",
        snippet: "A snippet",
        url: "https://example.com/a",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
}

beforeEach(() => {
  mockParse.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ambiguous-truncation retry is billed twice and counted twice", () => {
  it("records both attempts when the retry succeeds", async () => {
    mockParse.mockResolvedValueOnce(truncated(100)).mockResolvedValueOnce(complete(200));
    const { writeCard } = await import("@/lib/writeCard");

    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () => writeCard(makeCluster(), 4));

    expect(mockParse).toHaveBeenCalledTimes(2);
    expect(collector.calls()).toHaveLength(2);
    // Both attempts' tokens, not just the winning one's.
    expect(collector.summarize().totalTokens.inputTokens).toBe(300);
  });

  it("records both attempts when the retry also fails and the whole card is dropped", async () => {
    // The worst case: two billed Sonnet calls and a thrown error, so the
    // card never reaches the digest. A cost report that showed $0.00 here
    // would be wrong in the most expensive direction possible.
    mockParse.mockResolvedValueOnce(truncated(100)).mockResolvedValueOnce(truncated(200));
    const { writeCard } = await import("@/lib/writeCard");

    const collector = createUsageCollector(AT);
    await expect(
      withUsageCollector(collector, () => writeCard(makeCluster(), 4))
    ).rejects.toThrow(/incomplete output even after retry/);

    expect(collector.calls()).toHaveLength(2);
    expect(collector.summarize().totalTokens.inputTokens).toBe(300);
  });

  it("records exactly one attempt when the first response is empty and no retry fires", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { title: "", shortSummary: "   ", labels: ["Tag"] },
      stop_reason: "end_turn",
      usage: usage(100),
    });
    const { writeCard } = await import("@/lib/writeCard");

    const collector = createUsageCollector(AT);
    await expect(
      withUsageCollector(collector, () => writeCard(makeCluster(), 4))
    ).rejects.toThrow(/produced empty output/);

    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(collector.calls()).toHaveLength(1);
  });

  it("surfaces the extra attempt in the summary as a call/work mismatch", async () => {
    // What the route actually prints: 2 writeCard calls for 1 expected card.
    mockParse.mockResolvedValueOnce(truncated(100)).mockResolvedValueOnce(complete(200));
    const { writeCard } = await import("@/lib/writeCard");

    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () => writeCard(makeCluster(), 4));

    const lines = [] as string[];
    vi.mocked(console.log).mockImplementation((line: string) => void lines.push(line));
    collector.report({ label: "digest complete", expectedCalls: { writeCard: 1 } });

    expect(lines.join("\n")).toContain("writeCard made 2 calls for 1");
  });
});
