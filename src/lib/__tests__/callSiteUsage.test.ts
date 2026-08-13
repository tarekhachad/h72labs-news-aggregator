import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import type { Card, Cluster } from "@/types";

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
  it("triageCluster records against the triage stage on Haiku", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { notable: true, severity: 4, reason: "significant" },
      usage: USAGE,
    });
    const { triageCluster } = await import("@/lib/triage");

    const calls = await recordedDuring(() => triageCluster(makeCluster()));

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

  it("records a triage call that threw, even though the route swallows the throw", async () => {
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { triageCluster } = await import("@/lib/triage");

    const collector = createUsageCollector(AT);
    await expect(
      withUsageCollector(collector, () => triageCluster(makeCluster()))
    ).rejects.toThrow("rate limited");

    expect(collector.calls()).toEqual([
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
