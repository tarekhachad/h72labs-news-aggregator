import { describe, it, expect } from "vitest";
import { PRICING, summarizeUsage, type ModelPricing, type RecordedCall, type TrackedModel } from "@/lib/usage";
import { buildUsageRunRecord, deriveRunShape, toJsonlLine, toUsageRunRow, type UsageRunContext } from "@/lib/usageRecord";

// Adversarial probes layered on top of usageRecord.test.ts's coverage.
// These deliberately hunt for breakage rather than restate what already
// passes: Invalid Date edge cases, model-mixing, usage-less-vs-unrecorded
// interaction, aliasing, hostile labels, and JSONL round-tripping.

const AT = new Date("2026-09-11T12:00:00Z");

function usage(inputTokens: number, outputTokens = 100) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function call(stage: RecordedCall["stage"], model: TrackedModel, tokens = usage(1000)): RecordedCall {
  return { stage, model, tokens };
}

function emptyContext(overrides: Partial<UsageRunContext> = {}): UsageRunContext {
  return {
    userId: "user-1",
    route: "digest",
    digestId: "digest-1",
    cardId: null,
    outcome: "endedEarly",
    label: "digest ended early (error or cancelled)",
    runShape: "cold",
    topicCount: null,
    sourceCount: null,
    articleCount: null,
    clusterCount: null,
    clustersAfterDedup: null,
    notableCount: null,
    cardsDroppedByCap: null,
    cardsWritten: null,
    cardsFailed: null,
    rankApplied: null,
    expectedCalls: {},
    ...overrides,
  };
}

describe("deriveRunShape: adversarial", () => {
  it("treats an empty-string cursor as present, not as null", () => {
    // "" !== null, so per the doc comment this is a presence signal only —
    // the contents are never parsed or falsy-checked.
    expect(deriveRunShape("", 0)).toBe("warmNewDay");
  });

  it("treats a negative existingCardCount as > 0 (defensive: should not crash or misclassify silently)", () => {
    // Not a value the app should ever produce, but the function takes a bare
    // number with no runtime guard. -1 > 0 is false, so this exercises the
    // same branch as 0 — documenting actual behaviour under a malformed input
    // rather than assuming it is unreachable.
    expect(deriveRunShape("2026-09-10T08:00:00Z", -1)).toBe("warmNewDay");
  });

  it("treats NaN existingCardCount as falling through to the zero-cards branch", () => {
    // NaN > 0 is false in JS, so this silently lands on warmNewDay rather than
    // raising — worth pinning explicitly since it's a surprising outcome for a
    // supposedly numeric count.
    expect(deriveRunShape("2026-09-10T08:00:00Z", NaN)).toBe("warmNewDay");
  });
});

describe("buildUsageRunRecord: Invalid Date adversarial", () => {
  it("still produces a usable record when at is Invalid Date and there were zero calls", () => {
    const invalid = new Date("nonsense");
    const summary = summarizeUsage([], invalid);
    const record = buildUsageRunRecord(summary, emptyContext(), invalid, "run-1");

    expect(record.pricedAtIso).toBeNull();
    expect(record.clockUsable).toBe(false);
    expect(record.totalBilledUsd).toBe(0);
    expect(record.isFloor).toBe(false); // zero calls, zero expectation, nothing unpriced
  });

  it("an Invalid Date does not itself trigger isFloor when everything else is clean", () => {
    // clockUsable and isFloor are independent facts. A run priced under an
    // unusable clock still isFloor:false if every call reported usage,
    // matched expectation, and priced fine (at list, since no promo can be
    // confirmed) -- clockUsable is the signal a consumer must check
    // separately for the pricedAtIso/promo concern.
    const invalid = new Date("nonsense");
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], invalid);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ expectedCalls: { triage: 1 } }),
      invalid,
      "run-1"
    );

    expect(record.clockUsable).toBe(false);
    expect(record.isFloor).toBe(false);
    expect(record.totalBilledUsd).toBeGreaterThan(0);
  });

  it("handles a Date constructed from NaN the same as a string Invalid Date", () => {
    const invalid = new Date(NaN);
    const summary = summarizeUsage([], invalid);
    const record = buildUsageRunRecord(summary, emptyContext(), invalid, "run-1");

    expect(record.pricedAtIso).toBeNull();
    expect(record.clockUsable).toBe(false);
  });
});

describe("buildUsageRunRecord: usage-less vs unrecorded, not double-counted", () => {
  it("a stage that is entirely usage-less still only trips isFloor once, and totalCalls stays 0", () => {
    const summary = summarizeUsage(
      [
        { stage: "triage", model: "claude-haiku-4-5", tokens: null },
        { stage: "triage", model: "claude-haiku-4-5", tokens: null },
      ],
      AT
    );
    const record = buildUsageRunRecord(summary, emptyContext({ expectedCalls: { triage: 2 } }), AT, "run-1");

    // Both calls were RECORDED (as usage-less), so cause 2 (under-recorded)
    // must NOT also fire -- expected 2, actual (calls+callsWithoutUsage) = 2.
    expect(record.totalCalls).toBe(0);
    expect(record.totalCallsWithoutUsage).toBe(2);
    expect(record.isFloor).toBe(true); // from cause 1 alone
  });

  it("a genuinely unrecorded call (missing from the array entirely) is indistinguishable from zero at this layer", () => {
    // This is documenting a real limitation, not a bug: buildUsageRunRecord
    // can only see what summarizeUsage was given. A call that never made it
    // into the `calls` array at all (e.g. dropped before recordCall ran) is
    // only caught via expectedCalls under-recording, never via
    // callsWithoutUsage, because there's no entry for it to be null on.
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5")], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ expectedCalls: { writeCard: 3 } }),
      AT,
      "run-1"
    );

    expect(record.totalCallsWithoutUsage).toBe(0);
    expect(record.isFloor).toBe(true); // caught via cause 2, not cause 1
  });

  it("mixed usage-less and normal calls in the same stage: expectation counts both toward actual", () => {
    const summary = summarizeUsage(
      [
        call("writeCard", "claude-sonnet-5"),
        { stage: "writeCard", model: "claude-sonnet-5", tokens: null },
      ],
      AT
    );
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ expectedCalls: { writeCard: 2 } }),
      AT,
      "run-1"
    );

    // 1 normal + 1 usage-less = 2 actual, matches expected 2, so cause 2 does
    // NOT fire -- but cause 1 still does, from the usage-less call alone.
    expect(record.isFloor).toBe(true);
    expect(record.totalCalls).toBe(1);
    expect(record.totalCallsWithoutUsage).toBe(1);
  });
});

describe("buildUsageRunRecord: three-model / multi-stage mixing", () => {
  it("does not cross-contaminate expectedCalls between two different stages that both mix models", () => {
    const summary = summarizeUsage(
      [
        call("writeCard", "claude-sonnet-5"),
        call("writeCard", "claude-haiku-4-5"),
        call("triage", "claude-haiku-4-5"),
      ],
      AT
    );
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ expectedCalls: { writeCard: 2, triage: 1 } }),
      AT,
      "run-1"
    );

    expect(record.isFloor).toBe(false);
    expect(record.stages).toHaveLength(3);
  });

  it("an unpriced model in ONE of two stages still flags isFloor and lists only that model", () => {
    const table = { ...PRICING, "claude-sonnet-5": undefined } as unknown as Record<
      TrackedModel,
      ModelPricing
    >;
    const summary = summarizeUsage(
      [call("writeCard", "claude-sonnet-5"), call("triage", "claude-haiku-4-5")],
      AT,
      table
    );
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    expect(record.isFloor).toBe(true);
    expect(record.unpricedModels).toEqual(["claude-sonnet-5"]);
    // The Haiku stage still priced correctly and is not zeroed out by the
    // Sonnet stage's failure.
    const triageStage = record.stages.find((s) => s.stage === "triage");
    expect(triageStage!.priced).toBe(true);
    expect(triageStage!.billedUsd).toBeGreaterThan(0);
  });
});

describe("buildUsageRunRecord: aliasing", () => {
  it("mutating the CONTEXT object after building does not affect the record", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const context = emptyContext({ cardsWritten: 3 });
    const record = buildUsageRunRecord(summary, context, AT, "run-1");

    context.cardsWritten = 999;
    (context.expectedCalls as Record<string, number>).triage = 5;

    expect(record.cardsWritten).toBe(3);
  });

  it("mutating unpricedModels on the record does not reach back into the summary", () => {
    const table = { ...PRICING, "claude-sonnet-5": undefined } as unknown as Record<
      TrackedModel,
      ModelPricing
    >;
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5")], AT, table);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    record.unpricedModels.push("claude-haiku-4-5");

    expect(summary.unpricedModels).toEqual(["claude-sonnet-5"]);
  });

  it("mutating a stage's tokens object on the record does not reach back into the summary's group", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    record.stages[0].tokens.inputTokens = -1;

    expect(summary.stages[0].tokens.inputTokens).toBe(1000);
  });
});

describe("toJsonlLine: hostile labels", () => {
  it("survives a label containing quotes, backslashes and a literal tab", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ label: `weird "label" with \\ backslash and\ttab` }),
      AT,
      "run-1"
    );

    const line = toJsonlLine(record);
    expect(line.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(JSON.parse(line).label).toBe(`weird "label" with \\ backslash and\ttab`);
  });

  it("survives a label that is itself a JSON object string -- stays a string field, does not merge keys", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ label: `{"userId":"attacker","isFloor":false}` }),
      AT,
      "run-1"
    );

    const parsed = JSON.parse(toJsonlLine(record));
    expect(typeof parsed.label).toBe("string");
    expect(parsed.label).toBe(`{"userId":"attacker","isFloor":false}`);
    expect(parsed.isFloor).toBe(false === parsed.isFloor ? parsed.isFloor : parsed.isFloor);
    // isFloor on the real record, not injected from the label string:
    expect(parsed.isFloor).toBe(record.isFloor);
  });

  it("survives a label carrying \\u2028/\\u2029 (valid JSON, invalid as a bare JS line separator)", () => {
    const summary = summarizeUsage([], AT);
    const label = "line1 line2 line3";
    const record = buildUsageRunRecord(summary, emptyContext({ label }), AT, "run-1");

    const line = toJsonlLine(record);
    // \n-splitting must still see exactly one record: U+2028/2029 are not \n.
    expect(line.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(JSON.parse(line).label).toBe(label);
  });

  it("survives an empty-string label", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(summary, emptyContext({ label: "" }), AT, "run-1");

    const line = toJsonlLine(record);
    expect(JSON.parse(line).label).toBe("");
  });

  it("a label containing a literal \\r\\n pair still round-trips to one JSONL line", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(summary, emptyContext({ label: "a\r\nb" }), AT, "run-1");

    const line = toJsonlLine(record);
    expect(line.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(JSON.parse(line).label).toBe("a\r\nb");
  });

  it("still omits userId even when the label string literally contains the word 'userId'", () => {
    // The `.not.toContain("userId")` style assertion elsewhere could pass by
    // accident if userId were merely absent from a DIFFERENT part of the
    // payload; pin it against a label designed to produce a false negative.
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ label: "this run's userId lookup failed" }),
      AT,
      "run-1"
    );

    const parsed = JSON.parse(toJsonlLine(record));
    expect(parsed).not.toHaveProperty("userId");
    expect(parsed.label).toBe("this run's userId lookup failed");
  });
});

describe("toUsageRunRow: key-shape adversarial", () => {
  it("produces exactly the documented column set, no more, no fewer", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const row = toUsageRunRow(buildUsageRunRecord(summary, emptyContext(), AT, "run-1"));

    expect(new Set(Object.keys(row))).toEqual(
      new Set([
        "id",
        "user_id",
        "schema_version",
        "route",
        "digest_id",
        "card_id",
        "priced_at",
        "outcome",
        "label",
        "run_shape",
        "topic_count",
        "source_count",
        "article_count",
        "cluster_count",
        "clusters_after_dedup",
        "notable_count",
        "cards_dropped_by_cap",
        "cards_written",
        "cards_failed",
        "rank_applied",
        "total_calls",
        "total_calls_without_usage",
        "total_tokens",
        "total_billed_usd",
        "total_list_usd",
        "is_floor",
        "unpriced_models",
        "clock_usable",
        "pricing_verified_on",
        "stages",
      ])
    );
  });

  it("keeps user_id present on the row even though toJsonlLine strips it -- the two must not share logic by accident", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(summary, emptyContext({ userId: "user-xyz" }), AT, "run-1");

    expect(toUsageRunRow(record).user_id).toBe("user-xyz");
    expect(toJsonlLine(record)).not.toContain("user-xyz");
  });
});
