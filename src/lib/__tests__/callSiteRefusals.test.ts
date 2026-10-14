import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Every page "blocked", so nothing here reaches the live web.
vi.mock("@/lib/extract", async (importOriginal) => {
  const blocked = async (urls: readonly string[]) =>
    urls.map((url) => ({ url, ok: false as const, reason: "robots" as const }));
  return {
    ...(await importOriginal<typeof import("@/lib/extract")>()),
    extractArticles: blocked,
    extractForStory: blocked,
  };
});
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import { GenerationRejectedError } from "@/lib/claudeText";
import { classifyCardFailure } from "@/lib/cardFailure";
import { FAIL_CLOSED } from "@/lib/triageOutcome";
import type { Card, Cluster } from "@/types";

// A refusal (HTTP 200, stop_reason "refusal") must take each step's existing
// failure path, be logged once per call with its category, and keep its
// usage. Each refused response below still carries a plausible parsed answer,
// so a site that read parsed_output before stop_reason would act on it.

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { maxRetries: 2, messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function refused(parsed_output: unknown, category = "cyber") {
  return {
    parsed_output,
    stop_reason: "refusal",
    stop_details: { type: "refusal", category, explanation: null },
    content: [],
    usage: { input_tokens: 100, output_tokens: 3 },
  };
}

function cluster(sources = 1): Cluster {
  return {
    topic: "Tech/AI",
    articles: Array.from({ length: sources }, (_, i) => ({
      title: `A title ${i}`,
      snippet: "A snippet",
      url: `https://example.com/${i}`,
      source: i % 2 === 0 ? "BBC" : "Reuters",
      topic: "Tech/AI",
      publishedAt: "2026-07-31T12:00:00Z",
    })),
  } as Cluster;
}

function cardForExpand(): Pick<Card, "topic" | "shortSummary" | "sources"> {
  return {
    topic: "Tech/AI",
    shortSummary: "A short summary.",
    sources: [{ title: "A title", url: "https://example.com/a", source: "BBC", snippet: "A snippet" }],
  };
}

/** Every console line that mentions a refusal, as one string per line. */
function refusalLines(): string[] {
  return (["log", "warn", "error"] as const)
    .flatMap((level) => vi.mocked(console[level]).mock.calls)
    .map((args) => args.map(String).join(" "))
    .filter((line) => line.includes("refused by the model"));
}

beforeEach(() => {
  mockParse.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a refusal takes each step's existing failure path", () => {
  it("triage: the batch fails, the split-retry ladder runs, and the cluster fails closed", async () => {
    mockParse.mockResolvedValue(refused({ verdicts: [{ index: 0, notable: true, severity: 5 }] }));
    const { triageClusters } = await import("@/lib/triage");

    const usage = createUsageCollector();
    const outcomes = await withUsageCollector(usage, () => triageClusters([cluster()]));

    expect(outcomes).toEqual([FAIL_CLOSED]);
    // The same ladder an API error takes: the whole batch, then one retry per depth.
    expect(mockParse).toHaveBeenCalledTimes(3);
    const lines = refusalLines();
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^\[triage\] batch of 1 for Tech\/AI failed:/);
      expect(line).toContain("triage refused by the model (category: cyber)");
    }
    expect(usage.calls().every((c) => c.tokens !== null)).toBe(true);
  });

  it("dedup: fails open, letting the cluster through", async () => {
    mockParse.mockResolvedValue(refused({ sameStory: true }, "bio"));
    const { isSameStory } = await import("@/lib/dedup");

    const usage = createUsageCollector();
    const same = await withUsageCollector(usage, () => isSameStory("candidate", "existing"));

    expect(same).toBe(false);
    expect(refusalLines()).toEqual([
      "[dedup] isSameStory failed, letting the cluster through: RefusalError: dedup refused by the model (category: bio)",
    ]);
    expect(usage.calls()).toHaveLength(1);
    expect(usage.calls()[0].tokens).not.toBeNull();
  });

  it("rank: falls back to null, leaving the front page unchanged", async () => {
    mockParse.mockResolvedValue(refused({ picks: [{ index: 0, rank: 1 }] }, "frontier_llm"));
    const { rankFrontPage } = await import("@/lib/rank");

    const result = await rankFrontPage([{ topic: "Tech/AI", severity: 4, text: "a summary" }]);

    expect(result).toBeNull();
    expect(refusalLines()).toEqual([
      "[rank] rankFrontPage failed, leaving today's front page unchanged: RefusalError: rank refused by the model (category: frontier_llm)",
    ]);
  });

  it.each([
    ["single-source", 1],
    ["multi-source", 3],
  ])("writeCard (%s): a failed card with reason empty and stop_reason refusal, never retried", async (_label, sources) => {
    mockParse.mockResolvedValue(refused({ title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] }));
    const { writeCard } = await import("@/lib/writeCard");
    const { modelForCluster } = await import("@/lib/cardModel");

    const usage = createUsageCollector();
    const error = await withUsageCollector(usage, () => writeCard(cluster(sources), 4)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GenerationRejectedError);
    expect(classifyCardFailure(error, modelForCluster(cluster(sources)), sources)).toMatchObject({
      reason: "empty",
      stopReason: "refusal",
    });
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(refusalLines()).toEqual(["[writeCard] writeCard refused by the model (category: cyber)"]);
    expect(usage.calls()).toHaveLength(1);
    expect(usage.calls()[0].tokens).not.toBeNull();
  });

  it("expand: rejects as an empty report, never retried, so the route answers with its error", async () => {
    mockParse.mockResolvedValue(refused({ report: "A complete report." }, "general_harms"));
    const { generateExpandedReport } = await import("@/lib/cards");

    const usage = createUsageCollector();
    const error = await withUsageCollector(usage, () => generateExpandedReport(cardForExpand())).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(GenerationRejectedError);
    expect((error as GenerationRejectedError).stopReason).toBe("refusal");
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(refusalLines()).toEqual(["[cards/expand] expand refused by the model (category: general_harms)"]);
    expect(usage.calls()[0].tokens).not.toBeNull();
  });
});
