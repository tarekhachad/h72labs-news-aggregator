import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster, Topic } from "@/types";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";

// QA gap tests: a topic getter that throws on a second read, through the
// split-retry ladder, with reasons on, on the reject branch, and with a
// headline getter that throws on the log's read.

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

function topicReadableOnce(topic: Topic, title: string) {
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

type V = { index: number; notable: boolean; severity: number; reason?: string };
const response = (verdicts: V[]) => ({
  parsed_output: { verdicts },
  usage: { input_tokens: 100, output_tokens: 20 },
});

// These tests read reject lines, which print one by one only on request.
beforeEach(() => {
  mockParse.mockReset();
  delete process.env.TRIAGE_REASONS;
  process.env.TRIAGE_LOG_REJECTS = "1";
});

afterEach(() => {
  delete process.env.TRIAGE_REASONS;
  delete process.env.TRIAGE_LOG_REJECTS;
  vi.restoreAllMocks();
});

describe("judgeBatch's verdict log — QA gaps", () => {
  it("never re-reads topic through the split-retry ladder after a failed first batch", async () => {
    // First call fails (network), the halves are then judged one each.
    mockParse
      .mockRejectedValueOnce(new Error("529 overloaded"))
      .mockResolvedValueOnce(response([{ index: 0, notable: true, severity: 4 }]))
      .mockResolvedValueOnce(response([{ index: 0, notable: false, severity: 1 }]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const a = topicReadableOnce("Morocco", "Story A");
    const b = topicReadableOnce("Morocco", "Story B");

    const outcomes = await triageClusters([a.cluster, b.cluster]);

    expect(outcomes).toEqual([
      { notable: true, severity: 4 },
      { notable: false, severity: 1 },
    ]);
    expect(mockParse).toHaveBeenCalledTimes(3);
    expect(a.reads()).toBe(1);
    expect(b.reads()).toBe(1);
    expect(error).toHaveBeenCalledWith("[triage] batch of 2 for Morocco failed:", expect.any(Error));
    expect(log).toHaveBeenCalledWith('[triage] Morocco — PASS (severity 4) — "Story A"');
    expect(log).toHaveBeenCalledWith('[triage] Morocco — reject — "Story B"');
  });

  it("keeps a reasons-on batch's verdicts, billed once, when topic throws on a second read", async () => {
    process.env.TRIAGE_REASONS = "1";
    mockParse.mockResolvedValue(
      response([{ index: 0, notable: false, severity: 1, reason: "routine local item" }]),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const poisoned = topicReadableOnce("Morocco", "Poisoned");
    const collector = createUsageCollector();

    const outcomes = await withUsageCollector(collector, () => triageClusters([poisoned.cluster]));

    expect(outcomes).toEqual([{ notable: false, severity: 1 }]);
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(collector.calls().filter((c) => c.stage === "triage")).toHaveLength(1);
    expect(poisoned.reads()).toBe(1);
    const lines = log.mock.calls
      .map(([l]) => l as string)
      .filter((l) => l.startsWith("[triage]") && !l.includes(" — judged "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[triage] Morocco — reject");
    expect(lines[0]).toContain("routine local item");
  });

  it("keeps verdicts billed once when the headline's articles getter throws on the log's read", async () => {
    mockParse.mockResolvedValue(response([{ index: 0, notable: true, severity: 5 }]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const cluster = makeCluster("Morocco", "Fine at prompt time");
    const articles = cluster.articles;
    let reads = 0;
    Object.defineProperty(cluster, "articles", {
      get() {
        reads += 1;
        if (reads > 1) throw new Error("articles read blew up");
        return articles;
      },
    });

    const outcomes = await triageClusters([cluster]);

    expect(outcomes).toEqual([{ notable: true, severity: 5 }]);
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[triage] Morocco — PASS (severity 5)");
  });

  it("logs every verdict in a multi-topic run from each batch's own topic", async () => {
    mockParse.mockImplementation(async (req: { messages: { content: string }[] }) => {
      const content = req.messages[0].content;
      return content.startsWith("Topic: Morocco")
        ? response([{ index: 0, notable: true, severity: 3 }])
        : response([{ index: 0, notable: false, severity: 1 }]);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const m = topicReadableOnce("Morocco", "M story");
    const t = topicReadableOnce("Technology" as Topic, "T story");

    await expect(triageClusters([m.cluster, t.cluster])).resolves.toEqual([
      { notable: true, severity: 3 },
      { notable: false, severity: 1 },
    ]);
    expect(mockParse).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('[triage] Morocco — PASS (severity 3) — "M story"');
    expect(log).toHaveBeenCalledWith('[triage] Technology — reject — "T story"');
  });

  it("keeps a billed verdict when building its log line throws (a severity the template can't stringify)", async () => {
    // Schema-valid input can't reach this: zod makes severity a number. The
    // mock hands back parsed_output directly, so this pins the guard around
    // building the line, not just around printing it.
    const severity = Symbol("not stringifiable") as unknown as number;
    mockParse.mockResolvedValue(response([{ index: 0, notable: true, severity }]));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters([makeCluster("Morocco", "S")]);

    expect(outcomes).toEqual([{ notable: true, severity }]);
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it("never rejects when every logger is dead and every call fails", async () => {
    mockParse.mockRejectedValue(new Error("down"));
    for (const level of ["log", "error", "warn"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {
        throw new Error("console is dead");
      });
    }
    const { triageClusters } = await import("@/lib/triage");
    const poisoned = topicReadableOnce("Morocco", "P");

    const outcomes = await triageClusters([poisoned.cluster, makeCluster("Morocco", "Q")]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.notable === false)).toBe(true);
    expect(poisoned.reads()).toBe(1);
  });
});
