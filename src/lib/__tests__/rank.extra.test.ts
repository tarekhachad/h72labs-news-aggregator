import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Topic } from "@/types";

// Same fake-Anthropic-constructor pattern as rank.test.ts.
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

describe("rankFrontPage: additional defensive-parsing edge cases", () => {
  it("drops a negative index rather than throwing or wrapping to the end of the array", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { picks: [{ index: -1, rank: 1 }] },
    });
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(3));

    expect(result).toEqual([null, null, null]);
  });

  it("a single candidate pool of one item can still be picked as rank 1", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { picks: [{ index: 0, rank: 1 }] },
    });
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(1));

    expect(result).toEqual([1]);
  });

  it("an empty picks array (a genuinely quiet day) yields an all-null result, not null itself", async () => {
    mockParse.mockResolvedValue({ parsed_output: { picks: [] } });
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(2));

    expect(result).toEqual([null, null]);
    expect(result).not.toBeNull();
  });

  it("mixing valid and out-of-range/duplicate picks keeps only the valid, first-seen ones", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        picks: [
          { index: 0, rank: 1 },
          { index: 50, rank: 2 }, // out of range -> dropped
          { index: 1, rank: 1 }, // duplicate rank -> dropped
          { index: 2, rank: 3 }, // valid
        ],
      },
    });
    const { rankFrontPage } = await import("@/lib/rank");
    const result = await rankFrontPage(makeCandidates(3));

    expect(result).toEqual([1, null, 3]);
  });
});
