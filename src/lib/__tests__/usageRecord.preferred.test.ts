import { describe, it, expect } from "vitest";
import { summarizeUsage } from "@/lib/usage";
import { buildUsageRunRecord, toJsonlLine, toUsageRunRow, type UsageRunContext } from "@/lib/usageRecord";

const AT = new Date("2026-10-02T12:00:00Z");

/** A context written the way every caller wrote one before the two new counts existed. */
function legacyContext(overrides: Partial<UsageRunContext> = {}): UsageRunContext {
  return {
    userId: "user-1",
    route: "digest",
    digestId: "digest-1",
    cardId: null,
    outcome: "complete",
    label: "digest complete",
    runShape: "firstEver",
    topicCount: 13,
    sourceCount: 0,
    articleCount: 40,
    clusterCount: 12,
    clustersAfterDedup: 12,
    notableCount: 4,
    cardsDroppedByCap: 0,
    cardsWritten: 4,
    cardsFailed: 0,
    cardFailures: [],
    triageFailedClosed: 0,
    rankApplied: true,
    expectedCalls: {},
    ...overrides,
  };
}

const build = (context: UsageRunContext) => buildUsageRunRecord(summarizeUsage([], AT), context, AT, "run-1");

describe("clustersBoosted and topicsDropped on the run record", () => {
  it("carry the route's counts to the record, the row and the JSONL line", () => {
    const record = build(legacyContext({ clustersBoosted: 3, topicsDropped: 2 }));
    expect(record.clustersBoosted).toBe(3);
    expect(record.topicsDropped).toBe(2);

    const row = toUsageRunRow(record);
    expect(row.clusters_boosted).toBe(3);
    expect(row.topics_dropped).toBe(2);

    const line = JSON.parse(toJsonlLine(record));
    expect(line.clustersBoosted).toBe(3);
    expect(line.topicsDropped).toBe(2);
  });

  it("keep a measured zero as zero", () => {
    const row = toUsageRunRow(build(legacyContext({ clustersBoosted: 0, topicsDropped: 0 })));
    expect(row.clusters_boosted).toBe(0);
    expect(row.topics_dropped).toBe(0);
  });

  it("write an absent count as null (never measured), never as undefined or 0", () => {
    const record = build(legacyContext());
    expect(record.clustersBoosted).toBeNull();
    expect(record.topicsDropped).toBeNull();

    const row = toUsageRunRow(record);
    expect(row).toHaveProperty("clusters_boosted", null);
    expect(row).toHaveProperty("topics_dropped", null);

    const line = JSON.parse(toJsonlLine(record));
    expect(line).toHaveProperty("clustersBoosted", null);
    expect(line).toHaveProperty("topicsDropped", null);
  });
});
