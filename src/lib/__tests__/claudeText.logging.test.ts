import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster } from "@/types";
import { generateWithRetryOnAmbiguousTruncation } from "@/lib/claudeText";

// Covers the shared retry warning through both of its callers as well as
// directly, since writeCard and the expand path each depend on it.
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

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

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockParse.mockReset();
  // usageCollector logs one line per call; its own guard is not under test.
  vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
    throw new Error("stderr closed");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the incomplete-output retry when its warning throws", () => {
  it("still makes the retry and returns its result", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ text: "Cut off mid", stopReason: "end_turn" })
      .mockResolvedValueOnce({ text: "A finished sentence.", stopReason: "end_turn" });

    await expect(generateWithRetryOnAmbiguousTruncation(generate, "test")).resolves.toEqual({
      text: "A finished sentence.",
      stopReason: "end_turn",
    });
    expect(generate).toHaveBeenCalledTimes(2);
    // The throwing line was actually reached, so the test exercises the guard.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("writeCard still returns the retried card, with the retry's title and labels", async () => {
    mockParse
      .mockResolvedValueOnce({
        parsed_output: { title: "First Try", shortSummary: "Cut off mid", labels: ["Old"] },
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: { title: "Second Try", shortSummary: "A finished sentence.", labels: ["New"] },
        stop_reason: "end_turn",
      });
    const { writeCard } = await import("@/lib/writeCard");

    const card = await writeCard(makeCluster(), 4);

    expect(card.shortSummary).toBe("A finished sentence.");
    expect(card.title).toBe("Second Try");
    expect(card.labels).toEqual(["New"]);
    expect(mockParse).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("the expand path still returns the retried report", async () => {
    mockParse
      .mockResolvedValueOnce({ parsed_output: { report: "Cut off mid" }, stop_reason: "end_turn" })
      .mockResolvedValueOnce({
        parsed_output: { report: "A finished report." },
        stop_reason: "end_turn",
      });
    const { generateExpandedReport } = await import("@/lib/cards");

    await expect(
      generateExpandedReport({ topic: "Tech/AI", shortSummary: "Summary.", sources: [] }),
    ).resolves.toBe("A finished report.");
    expect(mockParse).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
