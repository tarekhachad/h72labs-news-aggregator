/**
 * Coverage for the run-shape vocabulary and its legacy mapping.
 *
 * The names themselves are mechanical. The part that can silently break is the
 * READ path: `usage_runs` has no update policy by design, so every row written
 * before the rename keeps the old vocabulary forever, and the local JSONL is
 * deliberately left unmigrated for the same reason — one reader-side mechanism
 * rather than a file rewrite plus a mapping that has to agree with it.
 *
 * If normalisation regresses, a legacy record does not throw. It fails
 * `sectionKeyOf`, drops out of every section, and — depending on which guard
 * broke first — is either silently discarded or counted in the headline while
 * appearing nowhere. That second state is this report's oldest bug family (five
 * instances, per `costReport.ts`'s own docstring), which is why these assert
 * placement and totals rather than just the mapping.
 */
import { describe, it, expect } from "vitest";
import { deriveRunShape, normalizeRunShape, RUN_SHAPES, type RunShape } from "@/lib/usageRecord";
import { buildCostReport, parseUsageRunLines } from "@/lib/costReport";

const LEGACY_TO_CURRENT: ReadonlyArray<readonly [string, RunShape]> = [
  ["cold", "firstEver"],
  ["warmNewDay", "firstOfDay"],
  ["warmSameDay", "sameDayTopUp"],
];

function recordWith(runShape: string, billed: number) {
  return {
    schemaVersion: 1,
    runId: `run-${runShape}-${billed}`,
    route: "digest",
    digestId: "d1",
    cardId: null,
    outcome: "complete",
    label: "digest complete",
    runShape,
    pricedAtIso: "2026-09-14T12:00:00.000Z",
    topicCount: 2,
    sourceCount: 3,
    articleCount: 10,
    clusterCount: 8,
    clustersAfterDedup: 8,
    notableCount: 2,
    cardsDroppedByCap: 0,
    cardsWritten: 2,
    cardsFailed: 0,
    rankApplied: true,
    totalCalls: 3,
    totalCallsWithoutUsage: 0,
    totalTokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    totalBilledUsd: billed,
    totalListUsd: billed,
    isFloor: false,
    unpricedModels: [],
    clockUsable: true,
    pricingVerifiedOn: "2026-09-11",
    stages: [],
  };
}

describe("run-shape rename — the current vocabulary", () => {
  it("derives the product's names, not the cursor's", () => {
    // Null cursor and no cards: nothing has ever generated for this user.
    expect(deriveRunShape(null, 0)).toBe("firstEver");
    // Cursor set, no cards yet today: the day's first brief.
    expect(deriveRunShape("2026-09-13T00:00:00.000Z", 0)).toBe("firstOfDay");
    // Cursor set AND today's cards exist: "Complete Today's Brief".
    expect(deriveRunShape("2026-09-14T08:00:00.000Z", 5)).toBe("sameDayTopUp");
  });

  it("never emits a legacy name from the classifier", () => {
    const emitted = [
      deriveRunShape(null, 0),
      deriveRunShape(null, null),
      deriveRunShape("x", 0),
      deriveRunShape("x", 3),
      deriveRunShape("x", null),
      deriveRunShape(null, 2),
    ];
    for (const shape of emitted) {
      expect(RUN_SHAPES).toContain(shape);
      expect(["cold", "warmNewDay", "warmSameDay"]).not.toContain(shape);
    }
  });

  it("RUN_SHAPES is exactly the union, with no duplicates", () => {
    expect(new Set(RUN_SHAPES).size).toBe(RUN_SHAPES.length);
    expect([...RUN_SHAPES].sort()).toEqual(
      ["firstEver", "firstOfDay", "sameDayTopUp", "unknown"].sort()
    );
  });
});

describe("run-shape rename — reading rows written before it", () => {
  it.each(LEGACY_TO_CURRENT)("maps the legacy %s to %s", (legacy, current) => {
    expect(normalizeRunShape(legacy)).toBe(current);
  });

  it("passes current names through unchanged", () => {
    for (const shape of RUN_SHAPES) expect(normalizeRunShape(shape)).toBe(shape);
  });

  it("rejects anything that is not a run shape, rather than guessing", () => {
    for (const bad of ["", "COLD", "Cold", "warm", "firstever", 0, 1, null, undefined, {}, []]) {
      expect(normalizeRunShape(bad)).toBeNull();
    }
  });

  it("cannot be fooled by a polluted prototype", () => {
    // The mapping is consulted with Object.hasOwn for the same reason the
    // pricing table is: an inherited key must not be able to supply a shape.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.somethingInherited = "firstEver";
    try {
      expect(normalizeRunShape("somethingInherited")).toBeNull();
    } finally {
      delete proto.somethingInherited;
    }
  });
});

describe("run-shape rename — legacy rows still reach a section", () => {
  it("groups a legacy record with its renamed equivalent instead of dropping it", () => {
    const lines = [
      JSON.stringify(recordWith("cold", 0.1)),        // legacy
      JSON.stringify(recordWith("firstEver", 0.3)),   // current, same bucket
    ];
    const { records, skipped } = parseUsageRunLines(lines);
    expect(skipped).toBe(0);
    expect(records).toHaveLength(2);

    const report = buildCostReport(records, skipped);
    expect(report.totalRuns).toBe(2);

    const section = report.sections.find(
      (s) => s.route === "digest" && s.runShape === "firstEver"
    );
    expect(section).toBeDefined();
    expect(section?.totalRuns).toBe(2);
  });

  it("leaves nothing counted in the headline but shown in no section", () => {
    const lines = LEGACY_TO_CURRENT.map(([legacy], i) =>
      JSON.stringify(recordWith(legacy, 0.1 * (i + 1)))
    );
    const { records, skipped } = parseUsageRunLines(lines);
    const report = buildCostReport(records, skipped);

    const placed = report.sections.reduce((sum, s) => sum + s.totalRuns, 0);
    // The invariant that five separate bugs in this module each violated.
    expect(placed).toBe(report.totalRuns);
    expect(report.totalRuns).toBe(LEGACY_TO_CURRENT.length);
  });
});
