import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Topic } from "@/types";

// Each picked country is triaged on its own: its own batch, and named in the
// prompt's topic line, so it is judged against its own typical day.

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
        snippet: "A snippet",
        url: `https://example.com/${title}`,
        source: "BBC",
        topic,
        publishedAt: "2026-10-03T12:00:00Z",
      },
    ],
  };
}

const sentContent = (call: number) => mockParse.mock.calls[call][0].messages[0].content as string;

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockImplementation(async (params: { messages: { content: string }[] }) => {
    const count = (params.messages[0].content.match(/^\d+\. /gm) ?? []).length;
    return {
      parsed_output: {
        verdicts: Array.from({ length: count }, (_, i) => ({ index: i, notable: true, severity: 3 })),
      },
    };
  });
});

describe("planTriageBatches per country", () => {
  it("batches each country apart from the others and from plain topics", async () => {
    const { planTriageBatches } = await import("@/lib/triage");
    const clusters = [
      makeCluster("Countries", "u1", "Uganda"),
      makeCluster("Tech/AI", "t1"),
      makeCluster("Countries", "k1", "Kenya"),
      makeCluster("Countries", "u2", "Uganda"),
    ];

    expect(planTriageBatches(clusters)).toEqual([
      { topic: "Countries", subtopic: "Uganda", indices: [0, 3] },
      { topic: "Tech/AI", subtopic: null, indices: [1] },
      { topic: "Countries", subtopic: "Kenya", indices: [2] },
    ]);
  });

  it("plans a missing, null, empty or non-string subtopic as none", async () => {
    const { planTriageBatches } = await import("@/lib/triage");
    const clusters = [
      makeCluster("Tech/AI", "a"),
      makeCluster("Tech/AI", "b", null),
      makeCluster("Tech/AI", "c", ""),
      { ...makeCluster("Tech/AI", "d"), subtopic: 7 as unknown as string },
    ];

    expect(planTriageBatches(clusters)).toEqual([{ topic: "Tech/AI", subtopic: null, indices: [0, 1, 2, 3] }]);
  });

  it("plans a cluster whose subtopic getter throws as malformed, leaving the rest planned", async () => {
    const { planTriageBatches } = await import("@/lib/triage");
    const bad = makeCluster("Countries", "x");
    Object.defineProperty(bad, "subtopic", {
      get() {
        throw new Error("boom");
      },
    });

    expect(planTriageBatches([bad, makeCluster("Tech/AI", "t")])).toEqual([
      { topic: "Tech/AI", subtopic: null, indices: [1] },
    ]);
  });
});

describe("triageClusters per country", () => {
  it("names the country in the topic line, one call per country", async () => {
    const { triageClusters } = await import("@/lib/triage");
    await triageClusters([
      makeCluster("Countries", "u1", "Uganda"),
      makeCluster("Countries", "k1", "Kenya"),
    ]);

    const lines = [0, 1].map((i) => sentContent(i).split("\n")[0]).sort();
    expect(lines).toEqual(["Topic: Countries: Kenya", "Topic: Countries: Uganda"]);
  });

  it("leaves a plain topic's prompt exactly as before", async () => {
    const { triageClusters } = await import("@/lib/triage");
    await triageClusters([makeCluster("Tech/AI", "t1")]);

    expect(sentContent(0).startsWith("Topic: Tech/AI\n\nClusters:\n\n0. ")).toBe(true);
  });

  it("returns outcomes in input order across interleaved countries", async () => {
    mockParse.mockReset();
    mockParse.mockImplementation(async (params: { messages: { content: string }[] }) => {
      const content = params.messages[0].content;
      const count = (content.match(/^\d+\. /gm) ?? []).length;
      const notable = content.startsWith("Topic: Countries: Uganda");
      return {
        parsed_output: {
          verdicts: Array.from({ length: count }, (_, i) => ({ index: i, notable, severity: notable ? 4 : 1 })),
        },
      };
    });
    const { triageClusters } = await import("@/lib/triage");
    const outcomes = await triageClusters([
      makeCluster("Countries", "u1", "Uganda"),
      makeCluster("Countries", "k1", "Kenya"),
      makeCluster("Countries", "u2", "Uganda"),
    ]);

    expect(outcomes.map((o) => o.notable)).toEqual([true, false, true]);
  });
});
