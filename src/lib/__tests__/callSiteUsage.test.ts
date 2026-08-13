import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import type { Card, Cluster, Topic } from "@/types";

// Pins that each of the five Claude call sites is actually wrapped in
// `recordCall`, with the right stage label and the right model.
//
// This is the test that stops "everything green while the real path records
// nothing." The rest of the suite mocks `messages.parse` with responses that
// carry no `usage` and runs outside any collector scope, so it passes
// whether or not the instrumentation exists at all — by design, since that
// no-op behaviour is what keeps those ~30 tests untouched. Something has to
// assert the positive case, and it has to name the stage/model literals so a
// copy-paste between call sites is caught rather than silently misfiling a
// stage's cost.

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

const AT = new Date("2026-08-13T12:00:00Z");

const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const EXPECTED_TOKENS = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function makeCluster(): Cluster {
  return {
    topic: "Tech/AI",
    articles: [
      {
        title: "A title",
        snippet: "A snippet",
        url: "https://example.com/a",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
}

/** n clusters, all one topic, distinct titles. */
function clustersOf(topic: Topic, n: number): Cluster[] {
  return Array.from({ length: n }, (_, i) => ({
    topic,
    articles: [
      {
        title: `${topic}-${i}`,
        snippet: "A snippet",
        url: `https://example.com/${topic}-${i}`,
        source: "BBC",
        topic,
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  }));
}

/** Two outlets on the same story — the case writeCard keeps Sonnet for. */
function makeMultiSourceCluster(): Cluster {
  const base = makeCluster();
  return {
    ...base,
    articles: [
      ...base.articles,
      {
        title: "Another outlet's title",
        snippet: "Another snippet",
        url: "https://example.com/b",
        source: "NYT",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T13:00:00Z",
      },
    ],
  };
}

function makeCardForExpand(): Pick<Card, "topic" | "shortSummary" | "sources"> {
  return {
    topic: "Tech/AI",
    shortSummary: "A short summary.",
    sources: [
      { title: "A title", url: "https://example.com/a", source: "BBC", snippet: "A snippet" },
    ],
  };
}

beforeEach(() => {
  mockParse.mockReset();
  // The collector logs a line per call; silence it so the suite stays readable.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs `fn` inside a fresh collector and returns what the collector saw. */
async function recordedDuring(fn: () => Promise<unknown>) {
  const collector = createUsageCollector(AT);
  await withUsageCollector(collector, fn);
  return collector.calls();
}

describe("Claude call sites report their token usage", () => {
  it("triageClusters records one triage call per batch on Haiku", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { verdicts: [{ index: 0, notable: true, severity: 4 }] },
      usage: USAGE,
    });
    const { triageClusters } = await import("@/lib/triage");

    const calls = await recordedDuring(() => triageClusters([makeCluster()]));

    expect(calls).toEqual([
      { stage: "triage", model: "claude-haiku-4-5", tokens: EXPECTED_TOKENS },
    ]);
  });

  it("isSameStory records against the dedup stage on Haiku", async () => {
    mockParse.mockResolvedValue({ parsed_output: { sameStory: true }, usage: USAGE });
    const { isSameStory } = await import("@/lib/dedup");

    const calls = await recordedDuring(() => isSameStory("candidate text", "existing summary"));

    expect(calls).toEqual([{ stage: "dedup", model: "claude-haiku-4-5", tokens: EXPECTED_TOKENS }]);
  });

  it("rankFrontPage records against the rank stage on Haiku", async () => {
    mockParse.mockResolvedValue({ parsed_output: { picks: [{ index: 0, rank: 1 }] }, usage: USAGE });
    const { rankFrontPage } = await import("@/lib/rank");

    const calls = await recordedDuring(() =>
      rankFrontPage([{ topic: "Tech/AI", severity: 4, text: "a summary" }])
    );

    expect(calls).toEqual([{ stage: "rank", model: "claude-haiku-4-5", tokens: EXPECTED_TOKENS }]);
  });

  // Both writeCard paths are pinned, because the stage now spans two models
  // and the summary prices them separately — a routing bug would misprice a
  // whole stage rather than just changing quality.
  it("writeCard records a single-source cluster against Haiku", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        title: "A Headline",
        shortSummary: "A complete sentence.",
        labels: ["Tag"],
      },
      stop_reason: "end_turn",
      usage: USAGE,
    });
    const { writeCard } = await import("@/lib/writeCard");

    const calls = await recordedDuring(() => writeCard(makeCluster(), 4));

    expect(calls).toEqual([
      { stage: "writeCard", model: "claude-haiku-4-5", tokens: EXPECTED_TOKENS },
    ]);
    // Haiku has no adaptive thinking to disable, and no other Haiku call
    // site in this app sends the parameter.
    expect(mockParse.mock.calls[0][0].thinking).toBeUndefined();
  });

  it("writeCard records a multi-source cluster against Sonnet", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        title: "A Headline",
        shortSummary: "A complete sentence.",
        labels: ["Tag"],
      },
      stop_reason: "end_turn",
      usage: USAGE,
    });
    const { writeCard } = await import("@/lib/writeCard");

    const calls = await recordedDuring(() => writeCard(makeMultiSourceCluster(), 4));

    expect(calls).toEqual([
      { stage: "writeCard", model: "claude-sonnet-5", tokens: EXPECTED_TOKENS },
    ]);
    expect(mockParse.mock.calls[0][0].thinking).toEqual({ type: "disabled" });
  });

  it("generateExpandedReport records against the expand stage on Sonnet", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { report: "A complete report." },
      stop_reason: "end_turn",
      usage: USAGE,
    });
    const { generateExpandedReport } = await import("@/lib/cards");

    const calls = await recordedDuring(() => generateExpandedReport(makeCardForExpand()));

    expect(calls).toEqual([{ stage: "expand", model: "claude-sonnet-5", tokens: EXPECTED_TOKENS }]);
  });
});

describe("Claude call sites still report on their failure paths", () => {
  // Each of these swallows or converts its own error, so a return value
  // could never carry the usage out. The call was still billed.
  it("records a dedup call that failed and returned its fail-open default", async () => {
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { isSameStory } = await import("@/lib/dedup");

    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () => isSameStory("candidate", "existing"));

    expect(collector.calls()).toEqual([
      { stage: "dedup", model: "claude-haiku-4-5", tokens: null },
    ]);
    expect(collector.summarize().totalCallsWithoutUsage).toBe(1);
  });

  it("records a rank call that failed and returned its null sentinel", async () => {
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { rankFrontPage } = await import("@/lib/rank");

    const collector = createUsageCollector(AT);
    const result = await withUsageCollector(collector, () =>
      rankFrontPage([{ topic: "Tech/AI", severity: 4, text: "a summary" }])
    );

    expect(result).toBeNull();
    expect(collector.calls()).toEqual([{ stage: "rank", model: "claude-haiku-4-5", tokens: null }]);
  });

  it("records every triage attempt that threw, including the split-retry ladder", async () => {
    // triageClusters swallows the throw itself now (the route lost its
    // per-cluster catch when batching landed), so the ONLY evidence these
    // calls happened is the collector. A failed attempt still costs a
    // request; leaving it unrecorded would report a cheaper run than the
    // real one, which is exactly what this module exists to prevent.
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { triageClusters } = await import("@/lib/triage");

    const collector = createUsageCollector(AT);
    await expect(
      withUsageCollector(collector, () => triageClusters([makeCluster()]))
      // Resolves, fail-closed — it does not reject.
    ).resolves.toEqual([{ notable: false, severity: 1 }]);

    // The initial attempt plus one retry at each of the two split depths.
    expect(collector.calls()).toEqual([
      { stage: "triage", model: "claude-haiku-4-5", tokens: null },
      { stage: "triage", model: "claude-haiku-4-5", tokens: null },
      { stage: "triage", model: "claude-haiku-4-5", tokens: null },
    ]);
  });

  it("does not short-circuit rankFrontPage's no-call path into a recorded call", async () => {
    // An empty candidate pool returns early without touching Claude.
    const { rankFrontPage } = await import("@/lib/rank");

    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () => rankFrontPage([]));

    expect(collector.calls()).toEqual([]);
    expect(mockParse).not.toHaveBeenCalled();
  });
});

// F.4.5 final review round: closes a specific gap in the existing coverage.
// callSiteUsage.test.ts above proves the REAL triage.ts retry ladder records
// one collector entry per real attempt (including retries). usage-wiring.test
// proves formatUsageSummary prints the right line shape ("made N calls for
// M" vs "WARNING: ... recorded") -- but only against a HAND-SIMULATED
// sequence of recordCall invocations standing in for triage. Nothing before
// this combines all three real pieces at once: the real triageBatchCount
// prediction, the real triageClusters retry ladder actually producing extra
// attempts, and the real formatUsageSummary rendering that combination. A
// regression in how any one of those three fit together (e.g. triageBatchCount
// silently starting to disagree with planTriageBatches under some cluster
// shape, or the split-retry ladder starting to under-count) could still slip
// through with every existing test green, because each existing test only
// ever exercises two of the three at once.
describe("cost summary: triageBatchCount's real prediction against triageClusters' real retry-ladder call count", () => {
  it("prints the retry ladder's extra attempts as the informational line, never a FLOOR warning, for a single-batch topic that fails once then recovers", async () => {
    let attempt = 0;
    mockParse.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("rate limited");
      return {
        parsed_output: { verdicts: [{ index: 0, notable: true, severity: 4 }] },
        usage: USAGE,
      };
    });
    const { triageClusters, triageBatchCount } = await import("@/lib/triage");
    const { formatUsageSummary } = await import("@/lib/usage");

    const clusters = [makeCluster()];
    const expected = triageBatchCount(clusters);
    expect(expected).toBe(1);

    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () => triageClusters(clusters));

    const text = formatUsageSummary(collector.summarize(), {
      label: "test run",
      expectedCalls: { triage: expected },
    }).join("\n");

    expect(attempt).toBe(2);
    expect(text).toContain("triage made 2 calls for 1");
    expect(text).not.toContain("WARNING: triage recorded");
  });

  it("prints the full 7-call worst-case ladder against a real 1-batch prediction without ever under-counting", async () => {
    // 20 clusters, one topic -> triageBatchCount predicts exactly 1 batch.
    // Every attempt at every depth fails, bottoming the ladder out at 7 real
    // recordCall invocations (1 + 2 + 4). The dangerous direction this round
    // is asked to rule out is triageBatchCount's prediction exceeding the
    // real recorded count (a false "spent less than we think" FLOOR) -- this
    // is the largest gap between predicted and actual the module can produce,
    // so it's the sharpest check of that direction.
    mockParse.mockRejectedValue(new Error("always fails"));
    const { triageClusters, triageBatchCount } = await import("@/lib/triage");
    const { formatUsageSummary } = await import("@/lib/usage");

    const clusters = clustersOf("Tech/AI", 20);
    const expected = triageBatchCount(clusters);
    expect(expected).toBe(1);

    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () => triageClusters(clusters));

    expect(collector.calls()).toHaveLength(7);
    const text = formatUsageSummary(collector.summarize(), {
      label: "test run",
      expectedCalls: { triage: expected },
    }).join("\n");

    expect(text).toContain("triage made 7 calls for 1");
    expect(text).not.toContain("WARNING: triage recorded");
  });

  it("holds across a spread of cluster shapes and failure patterns: real recorded triage attempts are never fewer than triageBatchCount's real prediction", async () => {
    // Property check standing in for "can expectedCalls.triage ever disagree
    // with the real call count in a way that misleads" — the misleading
    // direction is specifically actual < expected (the FLOOR warning, which
    // usage.ts reserves for "a billed call went unrecorded"). Every planned
    // batch's FIRST judgeBatch attempt runs unconditionally before any retry
    // logic, so structurally the real module can only ever match or exceed
    // its own prediction — this pins that invariant across shapes rather
    // than trusting the single-topic examples above to generalize.
    const shapes: Array<{ clusters: Cluster[]; fail: "never" | "always" | "once" }> = [
      { clusters: clustersOf("Tech/AI", 1), fail: "never" },
      { clusters: clustersOf("Tech/AI", 1), fail: "always" },
      { clusters: clustersOf("Tech/AI", 4), fail: "always" },
      { clusters: clustersOf("Tech/AI", 4), fail: "once" },
      { clusters: [...clustersOf("Tech/AI", 25), ...clustersOf("Morocco", 30)], fail: "never" },
      { clusters: [...clustersOf("Tech/AI", 25), ...clustersOf("Morocco", 30)], fail: "always" },
    ];

    for (const { clusters, fail } of shapes) {
      mockParse.mockReset();
      let attempt = 0;
      mockParse.mockImplementation(async () => {
        attempt += 1;
        if (fail === "always") throw new Error("always fails");
        if (fail === "once" && attempt === 1) throw new Error("first attempt fails");
        return {
          parsed_output: { verdicts: [{ index: 0, notable: true, severity: 4 }] },
          usage: USAGE,
        };
      });

      const { triageClusters, triageBatchCount } = await import("@/lib/triage");
      const expected = triageBatchCount(clusters);

      const collector = createUsageCollector(AT);
      await withUsageCollector(collector, () => triageClusters(clusters));

      const actual = collector.calls().length;
      expect(actual).toBeGreaterThanOrEqual(expected);
    }
  });
});
