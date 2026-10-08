import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster, Topic } from "@/types";

// A digest rejects ~200 clusters, and Vercel's log for one request stops after
// a few hundred lines, so by default triage prints its passes and one summary
// line per batch, and prints rejects one by one only on request.

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
      { title, snippet: "A snippet", url: `https://example.com/${title}`, source: "BBC", topic, publishedAt: "2026-10-05T12:00:00Z" },
    ],
  };
}

function verdicts(notable: boolean[]) {
  return {
    parsed_output: { verdicts: notable.map((n, index) => ({ index, notable: n, severity: n ? 3 : 1 })) },
  };
}

function triageLines(log: { mock: { calls: unknown[][] } }): string[] {
  return log.mock.calls.map((args) => String(args[0])).filter((l) => l.startsWith("[triage]"));
}

beforeEach(() => {
  mockParse.mockReset();
  delete process.env.TRIAGE_REASONS;
  delete process.env.TRIAGE_LOG_REJECTS;
});

afterEach(() => {
  delete process.env.TRIAGE_REASONS;
  delete process.env.TRIAGE_LOG_REJECTS;
  vi.restoreAllMocks();
});

const clusters = [makeCluster("Tech/AI", "Pass one"), makeCluster("Tech/AI", "Reject one"), makeCluster("Tech/AI", "Reject two")];

describe("triage log volume", () => {
  it("prints passes and a batch summary, not one line per reject, by default", async () => {
    mockParse.mockResolvedValue(verdicts([true, false, false]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters(clusters);

    expect(triageLines(log)).toEqual([
      '[triage] Tech/AI — PASS (severity 3) — "Pass one"',
      "[triage] Tech/AI — judged 3 of 3: 1 pass, 2 reject",
    ]);
  });

  it("prints every reject when TRIAGE_LOG_REJECTS=1", async () => {
    process.env.TRIAGE_LOG_REJECTS = "1";
    mockParse.mockResolvedValue(verdicts([true, false, false]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters(clusters);

    expect(triageLines(log)).toEqual([
      '[triage] Tech/AI — PASS (severity 3) — "Pass one"',
      '[triage] Tech/AI — reject — "Reject one"',
      '[triage] Tech/AI — reject — "Reject two"',
      "[triage] Tech/AI — judged 3 of 3: 1 pass, 2 reject",
    ]);
  });

  it("prints every reject on a calibration run with reasons on", async () => {
    process.env.TRIAGE_REASONS = "1";
    mockParse.mockResolvedValue({
      parsed_output: { verdicts: [{ index: 0, notable: false, severity: 1, reason: "routine" }] },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters([makeCluster("Tech/AI", "Reject one")]);

    expect(triageLines(log)[0]).toContain('[triage] Tech/AI — reject — "Reject one"');
  });

  it("counts only the verdicts that came back in the summary", async () => {
    // One slot missing: the summary says what was judged, and the missing one
    // goes through the retry ladder on its own.
    mockParse
      .mockResolvedValueOnce({ parsed_output: { verdicts: [{ index: 0, notable: true, severity: 3 }, { index: 2, notable: false, severity: 1 }] } })
      .mockResolvedValue(verdicts([false]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters(clusters);

    expect(triageLines(log)).toContain("[triage] Tech/AI — judged 2 of 3: 1 pass, 1 reject");
  });

  it("never lets the summary line cost a paid verdict", async () => {
    mockParse.mockResolvedValue(verdicts([true, false, false]));
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters(clusters)).resolves.toEqual([
      { notable: true, severity: 3 },
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
    ]);
    expect(mockParse).toHaveBeenCalledTimes(1);
  });
});
