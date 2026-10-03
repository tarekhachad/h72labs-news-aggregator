import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Topic } from "@/types";

vi.mock("@/lib/embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embeddings")>()),
  embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
}));

const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

import { filterAlreadyCovered } from "@/lib/dedup";

function mk(topic: Topic, title: string, subtopic?: string | null): Cluster {
  return {
    topic,
    ...(subtopic === undefined ? {} : { subtopic }),
    articles: [{ title, snippet: "d", url: `https://e.com/${title}`, source: "BBC", topic, publishedAt: "2026-10-03T12:00:00Z" }],
  };
}

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockResolvedValue({ parsed_output: { sameStory: true } });
});

describe("QA: dedup per unit, edge keys", () => {
  it("an empty-string subtopic cluster matches a null-subtopic card (same unit)", async () => {
    const kept = await filterAlreadyCovered([mk("Science" as Topic, "a", "")], [
      { topic: "Science" as Topic, subtopic: null, shortSummary: "x" },
    ]);
    expect(kept).toEqual([]);
  });

  it("a country cluster is not compared to a Countries card with no subtopic", async () => {
    const c = mk("Countries" as Topic, "u", "Uganda");
    const kept = await filterAlreadyCovered([c], [{ topic: "Countries" as Topic, subtopic: null, shortSummary: "x" }]);
    expect(kept).toEqual([c]);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("the same subtopic under another topic is not compared", async () => {
    const c = mk("Countries" as Topic, "u", "Uganda");
    const kept = await filterAlreadyCovered([c], [{ topic: "Science" as Topic, subtopic: "Uganda", shortSummary: "x" }]);
    expect(kept).toEqual([c]);
  });

  it("keeps input order and drops only the covered country's cluster among interleaved units", async () => {
    const u = mk("Countries" as Topic, "u", "Uganda");
    const k = mk("Countries" as Topic, "k", "Kenya");
    const p = mk("Science" as Topic, "p");
    const kept = await filterAlreadyCovered([u, k, p], [{ topic: "Countries" as Topic, subtopic: "Kenya", shortSummary: "x" }]);
    expect(kept).toEqual([u, p]);
  });

  it("zero-country invariant: plain topics with absent subtopics make one Haiku call per covered cluster, as before", async () => {
    const clusters = [mk("Science" as Topic, "a"), mk("Health" as Topic, "b"), mk("Science" as Topic, "c")];
    const kept = await filterAlreadyCovered(clusters, [{ topic: "Science" as Topic, shortSummary: "x" }]);
    expect(kept).toEqual([clusters[1]]);
    expect(mockParse).toHaveBeenCalledTimes(2);
  });
});
