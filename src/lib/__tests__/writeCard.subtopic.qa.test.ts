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

function makeCluster(topic: Topic, subtopic?: unknown): Cluster {
  return {
    topic,
    ...(subtopic === undefined ? {} : { subtopic: subtopic as string | null }),
    articles: [
      { title: "Title", snippet: "Snippet", url: "https://example.com/a", source: "BBC", topic, publishedAt: "2026-10-03T12:00:00Z" },
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

describe("QA: writeCard subtopic keying", () => {
  it("names a country that contains a colon or non-ASCII characters verbatim", () => {
    expect(buildWriteCardContent(makeCluster("Countries", "Côte d'Ivoire")).split("\n")[0]).toBe(
      "Topic: Countries: Côte d'Ivoire"
    );
  });

  it("zero-country invariant: a plain topic's whole prompt is byte-identical with subtopic missing, null or empty", () => {
    const base = buildWriteCardContent(makeCluster("Science" as Topic));
    expect(buildWriteCardContent(makeCluster("Science" as Topic, null))).toBe(base);
    expect(buildWriteCardContent(makeCluster("Science" as Topic, ""))).toBe(base);
    expect(base.startsWith("Topic: Science\n\n")).toBe(true);
  });

  it("an empty-string subtopic is stored as null, the same unit triage, cap and dedup treat it as", async () => {
    // triage/cardCap/dedup all fold "" into "no subtopic"; the stored card
    // should agree, or a card tagged "" sits under a country filter of "".
    const card = await writeCard(makeCluster("Countries", ""), 3);
    expect(card.subtopic).toBeNull();
  });
});
