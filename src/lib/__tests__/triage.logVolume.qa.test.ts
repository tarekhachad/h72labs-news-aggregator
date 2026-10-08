import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster, Topic } from "@/types";
import { FAIL_CLOSED } from "@/lib/triageOutcome";

// QA round 1: triage's batch summary line against malformed verdict lists,
// the split-retry ladder, and the never-rejects contract. SDK faked.

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse }, maxRetries: 2 };
  }
  return { default: FakeAnthropic };
});

function makeCluster(topic: Topic, title: string): Cluster {
  return {
    topic,
    articles: [{ title, snippet: "s", url: `https://example.com/${title}`, source: "BBC", topic, publishedAt: "2026-10-05T12:00:00Z" }],
  };
}
const lines = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.map((a) => String(a[0])).filter((l) => l.startsWith("[triage]"));
const summaries = (log: { mock: { calls: unknown[][] } }) => lines(log).filter((l) => l.includes(" — judged "));

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

const four = ["a", "b", "c", "d"].map((t) => makeCluster("Tech/AI", t));

describe("summary counts with malformed verdict lists", () => {
  it("duplicate index (first wins) and out-of-range indices are not counted", async () => {
    mockParse
      .mockResolvedValueOnce({
        parsed_output: {
          verdicts: [
            { index: 0, notable: true, severity: 3 },
            { index: 0, notable: false, severity: 1 }, // duplicate, dropped
            { index: 1, notable: false, severity: 1 },
            { index: 2, notable: true, severity: 4 },
            { index: 3, notable: false, severity: 1 },
            { index: 4, notable: true, severity: 5 }, // out of range
            { index: -1, notable: true, severity: 5 }, // out of range
          ],
        },
      });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const out = await triageClusters(four);
    expect(out.map((o) => o.notable)).toEqual([true, false, true, false]);
    expect(summaries(log)).toEqual(["[triage] Tech/AI — judged 4 of 4: 2 pass, 2 reject"]);
    // Only PASS lines, one per real pass (no line for the duplicate or out-of-range ones).
    expect(lines(log).filter((l) => l.includes("PASS"))).toHaveLength(2);
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it("an entirely out-of-range list: summary says judged 0, the ladder retries, counts per call", async () => {
    mockParse
      .mockResolvedValueOnce({ parsed_output: { verdicts: [{ index: 9, notable: true, severity: 3 }] } })
      .mockResolvedValue({ parsed_output: { verdicts: [{ index: 0, notable: false, severity: 1 }, { index: 1, notable: true, severity: 3 }] } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    await triageClusters(four);
    expect(summaries(log)).toEqual([
      "[triage] Tech/AI — judged 0 of 4: 0 pass, 0 reject",
      "[triage] Tech/AI — judged 2 of 2: 1 pass, 1 reject",
      "[triage] Tech/AI — judged 2 of 2: 1 pass, 1 reject",
    ]);
    expect(mockParse).toHaveBeenCalledTimes(3);
  });
});

describe("split-retry ladder", () => {
  it("a failed call prints no summary; each successful retry prints its own", async () => {
    mockParse
      .mockRejectedValueOnce(new Error("overloaded"))
      .mockResolvedValue({ parsed_output: { verdicts: [{ index: 0, notable: true, severity: 3 }, { index: 1, notable: false, severity: 1 }] } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const out = await triageClusters(four);
    expect(out.map((o) => o.notable)).toEqual([true, false, true, false]);
    expect(summaries(log)).toEqual([
      "[triage] Tech/AI — judged 2 of 2: 1 pass, 1 reject",
      "[triage] Tech/AI — judged 2 of 2: 1 pass, 1 reject",
    ]);
  });

  it("every call failing: no summary lines, every cluster fails closed, never rejects", async () => {
    mockParse.mockRejectedValue(new Error("credit balance is too low"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const out = await triageClusters(four);
    expect(out).toEqual([FAIL_CLOSED, FAIL_CLOSED, FAIL_CLOSED, FAIL_CLOSED]);
    expect(summaries(log)).toEqual([]);
  });
});

describe("never-rejects contract with the new lines", () => {
  it("console.log throwing only on summary lines costs no verdict and no extra call", async () => {
    mockParse.mockResolvedValue({ parsed_output: { verdicts: four.map((_, index) => ({ index, notable: index % 2 === 0, severity: 3 })) } });
    vi.spyOn(console, "log").mockImplementation((l: unknown) => {
      if (String(l).includes(" — judged ")) throw new Error("stdout gone");
    });
    const { triageClusters } = await import("@/lib/triage");
    const out = await triageClusters(four);
    expect(out.map((o) => o.notable)).toEqual([true, false, true, false]);
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it("default mode never reads a rejected cluster's headline (a poisoned reject cannot cost a verdict)", async () => {
    const poisoned = makeCluster("Tech/AI", "p");
    let reads = 0;
    Object.defineProperty(poisoned, "articles", {
      get() {
        reads++;
        if (reads > 1) throw new Error("poisoned");
        return [{ title: "p", snippet: "s", url: "https://example.com/p", source: "BBC", topic: "Tech/AI", publishedAt: "2026-10-05T12:00:00Z" }];
      },
    });
    mockParse.mockResolvedValue({ parsed_output: { verdicts: [{ index: 0, notable: false, severity: 1 }] } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    const out = await triageClusters([poisoned]);
    expect(out).toEqual([{ notable: false, severity: 1 }]);
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(lines(log)).toEqual(["[triage] Tech/AI — judged 1 of 1: 0 pass, 1 reject"]);
  });

  it("TRIAGE_LOG_REJECTS other than '1' keeps rejects quiet", async () => {
    process.env.TRIAGE_LOG_REJECTS = "true";
    mockParse.mockResolvedValue({ parsed_output: { verdicts: [{ index: 0, notable: false, severity: 1 }] } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { triageClusters } = await import("@/lib/triage");
    await triageClusters([makeCluster("Tech/AI", "r")]);
    expect(lines(log).filter((l) => l.includes("reject —"))).toEqual([]);
  });
});
