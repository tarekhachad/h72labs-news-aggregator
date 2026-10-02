import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster, Topic } from "@/types";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";

// Everything judgeBatch does after the paid call only reports on it, so
// nothing there may throw back into the split-retry ladder: that would
// re-send (and re-bill) a batch whose verdicts already came back.

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

/** A cluster whose topic reads fine once (at planning), then throws. */
function topicReadableOnce(topic: Topic, title: string): { cluster: Cluster; reads: () => number } {
  const cluster = makeCluster(topic, title);
  let reads = 0;
  Object.defineProperty(cluster, "topic", {
    get() {
      reads += 1;
      if (reads > 1) throw new Error("topic read blew up");
      return topic;
    },
  });
  return { cluster, reads: () => reads };
}

const verdicts = (count: number) => ({
  parsed_output: {
    verdicts: Array.from({ length: count }, (_, index) => ({ index, notable: true, severity: index + 2 })),
  },
  usage: { input_tokens: 100, output_tokens: 20 },
});

beforeEach(() => {
  mockParse.mockReset();
  delete process.env.TRIAGE_REASONS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("judgeBatch's verdict log after the paid call", () => {
  it("judges a batch once and keeps its verdicts when a cluster's topic throws on a second read", async () => {
    mockParse.mockResolvedValue(verdicts(2));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const poisoned = topicReadableOnce("Morocco", "The poisoned one");
    const collector = createUsageCollector();

    const outcomes = await withUsageCollector(collector, () =>
      triageClusters([makeCluster("Morocco", "A healthy story"), poisoned.cluster]),
    );

    expect(outcomes).toEqual([
      { notable: true, severity: 2 },
      { notable: true, severity: 3 },
    ]);
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(collector.calls().filter((call) => call.stage === "triage")).toHaveLength(1);
    // The line is built from the batch's topic, never from a second read.
    expect(poisoned.reads()).toBe(1);
    expect(log).toHaveBeenCalledWith('[triage] Morocco — PASS (severity 3) — "The poisoned one"');
  });

  it("keeps the verdicts when the console is dead too", async () => {
    mockParse.mockResolvedValue(verdicts(1));
    for (const level of ["log", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {
        throw new Error("console is dead");
      });
    }
    const { triageClusters } = await import("@/lib/triage");
    const poisoned = topicReadableOnce("Morocco", "The poisoned one");

    await expect(triageClusters([poisoned.cluster])).resolves.toEqual([{ notable: true, severity: 2 }]);
    expect(mockParse).toHaveBeenCalledTimes(1);
  });
});
