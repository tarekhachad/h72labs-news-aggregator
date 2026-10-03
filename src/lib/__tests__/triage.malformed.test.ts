import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Topic } from "@/types";
import { FAIL_CLOSED, isFailClosed } from "@/lib/triageOutcome";

// Same fake-Anthropic-constructor pattern as triage.test.ts.
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeCluster(topic: Topic, title: string): Cluster {
  return {
    topic,
    articles: [
      {
        title,
        snippet: "A snippet",
        url: `https://example.com/${title}`,
        source: "BBC",
        topic,
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
}

/** Judges every numbered cluster in the prompt notable at severity 4. */
function judgeEverythingNotable(args: {
  messages: { content: string }[];
}) {
  const count = (args.messages[0].content.match(/^\d+\. /gm) ?? []).length;
  return Promise.resolve({
    parsed_output: {
      verdicts: Array.from({ length: count }, (_, index) => ({
        index,
        notable: true,
        severity: 4,
      })),
    },
  });
}

/**
 * Valid clusters interleaved with every malformed shape the planner has to
 * survive. Index 5's topic getter throws, so even reading the field fails.
 */
function mixedClusters(): Cluster[] {
  const throwingTopic = makeCluster("Tech/AI", "getter");
  Object.defineProperty(throwingTopic, "topic", {
    get() {
      throw new Error("topic getter exploded");
    },
  });

  return [
    makeCluster("Tech/AI", "valid-0"),
    null as unknown as Cluster,
    makeCluster("Morocco", "valid-2"),
    { articles: makeCluster("Tech/AI", "no-topic").articles } as unknown as Cluster,
    { ...makeCluster("Tech/AI", "numeric-topic"), topic: 42 } as unknown as Cluster,
    throwingTopic,
    makeCluster("Tech/AI", "valid-6"),
  ];
}

const VALID = [0, 2, 6];
const MALFORMED = [1, 3, 4, 5];

beforeEach(() => {
  mockParse.mockReset();
  delete process.env.TRIAGE_REASONS;
});

describe("triage with malformed clusters", () => {
  it("leaves malformed clusters out of every batch and plans the rest", async () => {
    const { planTriageBatches } = await import("@/lib/triage");

    expect(planTriageBatches(mixedClusters())).toEqual([
      { topic: "Tech/AI", subtopic: null, indices: [0, 6] },
      { topic: "Morocco", subtopic: null, indices: [2] },
    ]);
  });

  it("fails each malformed cluster closed on its own and still judges the rest", async () => {
    mockParse.mockImplementation(judgeEverythingNotable);
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(mixedClusters());

    expect(outcomes).toHaveLength(7);
    for (const i of MALFORMED) expect(outcomes[i]).toBe(FAIL_CLOSED);
    for (const i of VALID) {
      expect(outcomes[i]).toEqual({ notable: true, severity: 4 });
      expect(isFailClosed(outcomes[i])).toBe(false);
    }
  });

  it("makes exactly as many calls as triageBatchCount predicts", async () => {
    mockParse.mockImplementation(judgeEverythingNotable);
    const { triageClusters, triageBatchCount } = await import("@/lib/triage");
    const clusters = mixedClusters();

    await triageClusters(clusters);

    expect(triageBatchCount(clusters)).toBe(2);
    expect(mockParse).toHaveBeenCalledTimes(triageBatchCount(clusters));
  });

  it("never rejects, and makes no call, when every cluster is malformed", async () => {
    const { triageClusters, triageBatchCount } = await import("@/lib/triage");
    const clusters = mixedClusters().filter((_, i) => MALFORMED.includes(i));

    const outcomes = await triageClusters(clusters);

    expect(outcomes).toHaveLength(MALFORMED.length);
    for (const outcome of outcomes) expect(outcome).toBe(FAIL_CLOSED);
    expect(triageBatchCount(clusters)).toBe(0);
    expect(mockParse).not.toHaveBeenCalled();
  });
});
