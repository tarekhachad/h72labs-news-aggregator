import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Topic } from "@/types";

// Cross-run dedup compares within one unit: a Uganda cluster is checked
// against Uganda cards only, never a Kenya card or a plain topic's.

// Every text embeds to the same vector, so any pair compared would clear the
// similarity gate and reach Haiku. Which pairs reach Haiku is then exactly
// which pairs dedup chose to compare.
vi.mock("@/lib/embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embeddings")>()),
  embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
}));

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeCluster(topic: Topic, title: string, subtopic?: string | null): Cluster {
  return {
    topic,
    ...(subtopic === undefined ? {} : { subtopic }),
    articles: [
      {
        title,
        snippet: "details",
        url: `https://example.com/${title}`,
        source: "BBC",
        topic,
        publishedAt: "2026-10-03T12:00:00Z",
      },
    ],
  };
}

const askedAbout = () =>
  mockParse.mock.calls.map((call) => {
    const content = call[0].messages[0].content as string;
    return content.split("\n")[1];
  });

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockResolvedValue({ parsed_output: { sameStory: true } });
});

describe("filterAlreadyCovered per country", () => {
  it("compares a country's cluster only with that country's cards", async () => {
    const { filterAlreadyCovered } = await import("@/lib/dedup");
    const result = await filterAlreadyCovered(
      [makeCluster("Countries", "uganda-story", "Uganda")],
      [
        { topic: "Countries", subtopic: "Kenya", shortSummary: "KENYA_CARD" },
        { topic: "Countries", subtopic: "Uganda", shortSummary: "UGANDA_CARD" },
      ]
    );

    expect(askedAbout()).toEqual(["UGANDA_CARD"]);
    expect(result).toEqual([]);
  });

  it("keeps a country's cluster when only another country has cards, without asking Haiku", async () => {
    const { filterAlreadyCovered } = await import("@/lib/dedup");
    const clusters = [makeCluster("Countries", "uganda-story", "Uganda")];
    const result = await filterAlreadyCovered(clusters, [
      { topic: "Countries", subtopic: "Kenya", shortSummary: "KENYA_CARD" },
    ]);

    expect(mockParse).not.toHaveBeenCalled();
    expect(result).toEqual(clusters);
  });

  it("matches a plain topic's cluster to its cards whether the subtopic is missing or null", async () => {
    const { filterAlreadyCovered } = await import("@/lib/dedup");
    const result = await filterAlreadyCovered(
      [makeCluster("Tech/AI", "a"), makeCluster("Tech/AI", "b", null)],
      [{ topic: "Tech/AI", subtopic: null, shortSummary: "TECH_CARD" }]
    );

    expect(askedAbout()).toEqual(["TECH_CARD", "TECH_CARD"]);
    expect(result).toEqual([]);
  });

  it("names the country in its log line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { filterAlreadyCovered } = await import("@/lib/dedup");
    await filterAlreadyCovered(
      [makeCluster("Countries", "uganda-story", "Uganda")],
      [{ topic: "Countries", subtopic: "Uganda", shortSummary: "UGANDA_CARD" }]
    );

    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("[dedup] Countries: Uganda — excluded"))).toBe(
      true
    );
    log.mockRestore();
  });
});
