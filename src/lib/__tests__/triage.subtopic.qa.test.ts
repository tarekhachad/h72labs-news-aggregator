import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Topic } from "@/types";

const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

import { planTriageBatches, triageBatchCount, triageClusters } from "@/lib/triage";

function mk(topic: Topic, title: string, subtopic?: string | null): Cluster {
  return {
    topic,
    ...(subtopic === undefined ? {} : { subtopic }),
    articles: [{ title, snippet: "s", url: `https://e.com/${title}`, source: "BBC", topic, publishedAt: "2026-10-03T12:00:00Z" }],
  };
}
const n = (k: number, topic: Topic, p: string, sub?: string | null) =>
  Array.from({ length: k }, (_, i) => mk(topic, `${p}${i}`, sub));

const allNotable = async (params: { messages: { content: string }[] }) => {
  const count = (params.messages[0].content.match(/^\d+\. /gm) ?? []).length;
  return { parsed_output: { verdicts: Array.from({ length: count }, (_, i) => ({ index: i, notable: true, severity: 3 })) } };
};

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockImplementation(allNotable);
});

describe("QA: triage batching per unit", () => {
  it("size-evens within each country independently (25 Uganda -> 13/12, 5 Kenya -> 5)", () => {
    const clusters = [...n(25, "Countries" as Topic, "u", "Uganda"), ...n(5, "Countries" as Topic, "k", "Kenya")];
    const batches = planTriageBatches(clusters);
    expect(batches.map((b) => [b.subtopic, b.indices.length])).toEqual([
      ["Uganda", 13],
      ["Uganda", 12],
      ["Kenya", 5],
    ]);
    expect(triageBatchCount(clusters)).toBe(3);
  });

  it("zero-country invariant: 62 plain clusters of one topic still plan 16/16/15/15, every batch subtopic null", () => {
    const batches = planTriageBatches(n(62, "Science" as Topic, "s"));
    expect(batches.map((b) => b.indices.length)).toEqual([16, 16, 15, 15]);
    expect(batches.every((b) => b.subtopic === null && b.topic === "Science")).toBe(true);
    expect(batches.flatMap((b) => b.indices)).toEqual(Array.from({ length: 62 }, (_, i) => i));
  });

  it("zero-country invariant: interleaved plain topics batch exactly by topic, first-seen order", () => {
    const clusters = [mk("Science" as Topic, "a"), mk("Health" as Topic, "b"), mk("Science" as Topic, "c", null)];
    expect(planTriageBatches(clusters)).toEqual([
      { topic: "Science", subtopic: null, indices: [0, 2] },
      { topic: "Health", subtopic: null, indices: [1] },
    ]);
  });

  it("a Countries cluster with no subtopic is its own unit, apart from every country", () => {
    const clusters = [mk("Countries" as Topic, "x"), mk("Countries" as Topic, "u", "Uganda")];
    expect(planTriageBatches(clusters).map((b) => b.subtopic)).toEqual([null, "Uganda"]);
  });

  it("a topic literally named like 'Countries: Uganda' does not merge with the Countries/Uganda unit", () => {
    const clusters = [mk("Countries: Uganda" as Topic, "a"), mk("Countries" as Topic, "b", "Uganda")];
    expect(planTriageBatches(clusters)).toHaveLength(2);
  });

  it("split-retry halves of a failed country batch still name that country", async () => {
    let calls = 0;
    mockParse.mockImplementation(async (params: { messages: { content: string }[] }) => {
      calls += 1;
      if (calls === 1) throw new Error("first call fails");
      return allNotable(params);
    });
    const outcomes = await triageClusters(n(4, "Countries" as Topic, "u", "Uganda"));
    const lines = mockParse.mock.calls.map((c) => (c[0].messages[0].content as string).split("\n")[0]);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lines)).toEqual(new Set(["Topic: Countries: Uganda"]));
    expect(outcomes.every((o) => o.notable)).toBe(true);
  });

  it("each country's prompt holds only its own clusters", async () => {
    await triageClusters([mk("Countries" as Topic, "UG-1", "Uganda"), mk("Countries" as Topic, "KE-1", "Kenya"), mk("Countries" as Topic, "UG-2", "Uganda")]);
    const byLine = new Map(
      mockParse.mock.calls.map((c) => {
        const content = c[0].messages[0].content as string;
        return [content.split("\n")[0], content] as const;
      })
    );
    expect(byLine.get("Topic: Countries: Uganda")).toMatch(/UG-1[\s\S]*UG-2/);
    expect(byLine.get("Topic: Countries: Uganda")).not.toMatch(/KE-1/);
    expect(byLine.get("Topic: Countries: Kenya")).not.toMatch(/UG-/);
  });
});
