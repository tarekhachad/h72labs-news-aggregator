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

describe("isSameStory when its failure log throws", () => {
  it("still fails open instead of rejecting", async () => {
    mockParse.mockRejectedValue(new Error("parse failed after billing"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr closed");
    });
    const { isSameStory } = await import("@/lib/dedup");

    await expect(isSameStory("candidate", "existing")).resolves.toBe(false);
    // The throwing line was actually reached, so the test exercises the guard.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps every other paid verdict in the run when one call fails and its log throws", async () => {
    mockParse.mockImplementation(async (params: { messages: { content: string }[] }) => {
      const content = params.messages[0].content;
      if (content.includes("broken-")) throw new Error("parse failed after billing");
      return { parsed_output: { sameStory: content.includes("dup-") } };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr closed");
    });
    const { filterAlreadyCovered } = await import("@/lib/dedup");
    const fresh = makeCluster("fresh-1");
    const broken = makeCluster("broken-1");

    // Without the guard this rejects, and the route falls back to all four,
    // re-covering both paid duplicates.
    await expect(
      filterAlreadyCovered(
        [makeCluster("dup-1"), fresh, broken, makeCluster("dup-2")],
        EXISTING,
      ),
    ).resolves.toEqual([fresh, broken]);
    expect(mockParse).toHaveBeenCalledTimes(4);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
