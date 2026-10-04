import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import { classifyCardFailure } from "@/lib/cardFailure";

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  // classifyCardFailure checks `instanceof Anthropic.APIError`.
  FakeAnthropic.APIError = class APIError extends Error {};
  return { default: FakeAnthropic };
});

const EMPTY: Cluster = { topic: "Tech/AI", articles: [] };

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockResolvedValue({
    parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] },
    stop_reason: "end_turn",
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeCard on a cluster with no articles", () => {
  it("fails before making any Claude call", async () => {
    const { writeCard, EmptyClusterError } = await import("@/lib/writeCard");

    await expect(writeCard(EMPTY, 4)).rejects.toBeInstanceOf(EmptyClusterError);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("records no usage, so nothing is billed for it", async () => {
    const { writeCard } = await import("@/lib/writeCard");
    const usage = createUsageCollector();

    await expect(withUsageCollector(usage, () => writeCard(EMPTY, 4))).rejects.toThrow(
      /has no articles/,
    );
    expect(usage.calls()).toEqual([]);
  });

  it("is recorded by the route's classifier as a named card failure", async () => {
    const { writeCard } = await import("@/lib/writeCard");
    const error = await writeCard(EMPTY, 4).catch((e: unknown) => e);

    expect(classifyCardFailure(error, "claude-sonnet-5", 0)).toEqual({
      reason: "other",
      model: "claude-sonnet-5",
      articleCount: 0,
      errorName: "EmptyClusterError",
    });
  });

  it("does not touch a normal cluster: one call, and the card comes back", async () => {
    const { writeCard } = await import("@/lib/writeCard");
    const cluster: Cluster = {
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

    const card = await writeCard(cluster, 4);

    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(card.shortSummary).toBe("A complete sentence.");
    expect(card.publishedAt).toBe("2026-07-31T12:00:00Z");
  });
});
