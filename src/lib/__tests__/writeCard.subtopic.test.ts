import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Topic } from "@/types";

const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

import { buildWriteCardContent, writeCard } from "@/lib/writeCard";

function makeCluster(topic: Topic, subtopic?: string | null): Cluster {
  return {
    topic,
    ...(subtopic === undefined ? {} : { subtopic }),
    articles: [
      {
        title: "Title",
        snippet: "Snippet",
        url: "https://example.com/a",
        source: "BBC",
        topic,
        publishedAt: "2026-10-03T12:00:00Z",
      },
    ],
  };
}

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockResolvedValue({
    parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] },
    stop_reason: "end_turn",
  });
});

describe("writeCard for a country", () => {
  it("tags the card with the cluster's country", async () => {
    const card = await writeCard(makeCluster("Countries", "Uganda"), 3);
    expect(card.subtopic).toBe("Uganda");
    expect(card.topic).toBe("Countries");
  });

  it("names the country in the writer's topic line", () => {
    expect(buildWriteCardContent(makeCluster("Countries", "Uganda")).startsWith("Topic: Countries: Uganda\n\n")).toBe(
      true
    );
  });

  it("sends that content to the model", async () => {
    await writeCard(makeCluster("Countries", "Uganda"), 3);
    expect(mockParse.mock.calls[0][0].messages[0].content).toBe(buildWriteCardContent(makeCluster("Countries", "Uganda")));
  });
});

describe("writeCard for a plain topic", () => {
  it("gives a null subtopic whether the cluster's is missing or null", async () => {
    expect((await writeCard(makeCluster("Tech/AI"), 3)).subtopic).toBeNull();
    expect((await writeCard(makeCluster("Tech/AI", null), 3)).subtopic).toBeNull();
  });

  it("keeps the topic line exactly as before", () => {
    expect(buildWriteCardContent(makeCluster("Tech/AI")).startsWith("Topic: Tech/AI\n\nSource: ")).toBe(true);
  });
});
