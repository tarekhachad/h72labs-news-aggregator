import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Topic } from "@/types";

// Same fake-Anthropic-constructor pattern as dedup.test.ts / triage.test.ts.
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeCandidates(n: number, topic: Topic = "Tech/AI") {
  return Array.from({ length: n }, (_, i) => ({
    topic,
    severity: 3,
    text: `Story ${i}`,
  }));
}

beforeEach(() => {
  mockParse.mockReset();
});

describe("rankFrontPage", () => {
  it("returns an empty array and makes no API call for an empty candidate pool", async () => {
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage([]);

    expect(result).toEqual([]);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("returns an index-aligned array with picks placed at their index and everything else null", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        picks: [
          { index: 2, rank: 1 },
          { index: 0, rank: 2 },
        ],
      },
    });
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(4));

    expect(result).toEqual([2, null, 1, null]);
  });

  it("ignores an out-of-range index defensively rather than throwing", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { picks: [{ index: 99, rank: 1 }] },
    });
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(2));

    expect(result).toEqual([null, null]);
  });

  it("drops a duplicate index or duplicate rank rather than overwriting or double-assigning", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        picks: [
          { index: 0, rank: 1 },
          { index: 0, rank: 2 }, // duplicate index -> dropped
          { index: 1, rank: 1 }, // duplicate rank -> dropped
        ],
      },
    });
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(2));

    expect(result).toEqual([1, null]);
  });

  it("fails open to null (not an all-null array) when parsed_output is missing -- a truncated/unparseable response must be indistinguishable from any other failure, not mistaken for 'the model picked nothing'", async () => {
    mockParse.mockResolvedValue({ parsed_output: null, stop_reason: "max_tokens" });
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(3));

    expect(result).toBeNull();
  });

  it("fails open to null (not a partial or all-null array) when the Anthropic call throws", async () => {
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(3));

    expect(result).toBeNull();
  });
});
