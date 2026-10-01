import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster } from "@/types";

// Every cluster and card embeds to the same vector, so every cluster clears
// the duplicate-candidate gate and reaches the paid isSameStory call.
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  };
});

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeCluster(title: string): Cluster {
  return {
    topic: "Tech/AI",
    articles: [
      {
        title,
        snippet: "details",
        url: `https://example.com/${title}`,
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
}

const EXISTING = [{ topic: "Tech/AI" as const, shortSummary: "already covered" }];

beforeEach(() => {
  mockParse.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filterAlreadyCovered when the exclusion log throws", () => {
  it("still excludes the confirmed duplicate", async () => {
    mockParse.mockResolvedValue({ parsed_output: { sameStory: true } });
    const logSpy = vi.spyOn(console, "log").mockImplementation((first) => {
      if (typeof first === "string" && first.startsWith("[dedup]")) {
        throw new Error("stdout closed");
      }
    });
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    await expect(
      filterAlreadyCovered([makeCluster("dup")], EXISTING),
    ).resolves.toEqual([]);
    expect(mockParse).toHaveBeenCalledTimes(1);
    // The throwing line was actually reached, so the test exercises the guard.
    expect(
      logSpy.mock.calls.some(
        ([first]) => typeof first === "string" && first.startsWith("[dedup]"),
      ),
    ).toBe(true);
  });

  it("excludes every duplicate and keeps every new story when all logging throws", async () => {
    mockParse.mockImplementation(async (params: { messages: { content: string }[] }) => ({
      parsed_output: { sameStory: params.messages[0].content.includes("dup-") },
    }));
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout closed");
    });
    const { filterAlreadyCovered } = await import("@/lib/dedup");
    const fresh = makeCluster("fresh-1");

    await expect(
      filterAlreadyCovered(
        [makeCluster("dup-1"), fresh, makeCluster("dup-2")],
        EXISTING,
      ),
    ).resolves.toEqual([fresh]);
    expect(mockParse).toHaveBeenCalledTimes(3);
  });
});
