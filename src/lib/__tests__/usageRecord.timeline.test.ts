import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUsageCollector } from "@/lib/usageCollector";
import { buildUsageRunRecord, settleCeilingFor } from "@/lib/usageRecord";

// The story timeline's own usage stage, through the settle and the run
// record: a failed check settles at its ceiling like any other stage's, and a
// missing one keeps the run at its full reservation.

const AT = new Date("2026-10-13T12:00:00Z");
const BOUND = { requestBytes: 3335, maxOutputTokens: 32, attempts: 1 };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function collector() {
  const usage = createUsageCollector(AT);
  usage.add({ stage: "triage", model: "claude-haiku-4-5", tokens: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  usage.add({ stage: "timeline", model: "claude-haiku-4-5", tokens: { inputTokens: 700, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  usage.add({ stage: "timeline", model: "claude-haiku-4-5", tokens: null, bound: BOUND });
  return usage;
}

describe("the timeline usage stage", () => {
  it("settles a failed check at the known total plus its ceiling", () => {
    const summary = collector().summarize();
    const ceiling = settleCeilingFor(summary, { triage: 1, timeline: 2 });
    expect(ceiling).not.toBeNull();
    expect(ceiling!).toBeCloseTo(summary.totalBilledUsd + summary.unmeasuredBoundUsd!, 10);
    expect(ceiling!).toBeLessThan(0.7);
  });

  it("keeps the full reservation when the timeline made calls nobody recorded", () => {
    expect(settleCeilingFor(collector().summarize(), { triage: 1, timeline: 3 })).toBeNull();
  });

  it("appears in the run record as its own stage", () => {
    const record = buildUsageRunRecord(
      collector().summarize(),
      {
        userId: "u",
        route: "digest",
        digestId: "d",
        cardId: null,
        outcome: "complete",
        label: "digest complete",
        runShape: "firstOfDay",
        topicCount: 3,
        sourceCount: 0,
        articleCount: 1,
        clusterCount: 1,
        clustersAfterDedup: 1,
        notableCount: 2,
        cardsDroppedByCap: 0,
        cardsWritten: 2,
        cardsFailed: 0,
        cardFailures: [],
        triageFailedClosed: 0,
        rankApplied: false,
        expectedCalls: { triage: 1, timeline: 2 },
      },
      AT,
      "run-1"
    );
    expect(record.stages.find((s) => s.stage === "timeline")).toMatchObject({ calls: 1, callsWithoutUsage: 1, model: "claude-haiku-4-5" });
    expect(record.isFloor).toBe(true);
  });
});
