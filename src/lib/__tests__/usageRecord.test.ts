import { describe, it, expect } from "vitest";
import {
  PRICING,
  PRICING_VERIFIED_ON,
  summarizeUsage,
  type ModelPricing,
  type RecordedCall,
  type TrackedModel,
  type UsageStage,
} from "@/lib/usage";
import {
  buildUsageRunRecord,
  COLUMN_OF,
  deriveRunShape,
  toJsonlLine,
  toUsageRunRow,
  type UsageRunContext,
  type UsageRunRecord,
} from "@/lib/usageRecord";

// Summaries are built by the REAL summarizeUsage rather than hand-written
// fixtures. A fixture would let this file agree with a UsageSummary shape
// that usage.ts no longer produces -- which is exactly how a record could
// start carrying a field that is always zero without a test noticing.

const AT = new Date("2026-09-11T12:00:00Z");

function usage(inputTokens: number, outputTokens = 100) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function call(stage: UsageStage, model: TrackedModel, tokens = usage(1000)): RecordedCall {
  return { stage, model, tokens };
}

/** A context with every measurable field genuinely unmeasured. */
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

describe("deriveRunShape", () => {
  it("calls a run with no cursor and no existing cards cold", () => {
    expect(deriveRunShape(null, 0)).toBe("cold");
  });

  it("calls a run with a cursor but no cards today warmNewDay", () => {
    expect(deriveRunShape("2026-09-10T08:00:00Z", 0)).toBe("warmNewDay");
  });

  it("calls a run with a cursor and cards already saved today warmSameDay", () => {
    expect(deriveRunShape("2026-09-11T08:00:00Z", 3)).toBe("warmSameDay");
  });

  it("returns unknown when the existing-cards fetch failed and a cursor exists", () => {
    // The count is genuinely unavailable, so warmNewDay vs warmSameDay -- the
    // split that decides whether dedup billed -- cannot be told apart.
    expect(deriveRunShape("2026-09-11T08:00:00Z", null)).toBe("unknown");
  });

  it("still calls it cold when the fetch failed but no generation has ever run", () => {
    // A null cursor is decisive on its own: cards and the cursor advance in
    // the same transaction, so there is nothing the failed fetch could have
    // found. Degrading this to "unknown" would throw away a fact we hold.
    expect(deriveRunShape(null, null)).toBe("cold");
  });

  it("returns unknown for the contradictory cards-without-a-cursor case", () => {
    // persist_generated_cards writes cards and advances the cursor atomically,
    // so this should be impossible. If it happens the run is genuinely mixed
    // -- a cold full lookback that will still pay for dedup -- and belongs in
    // no clean bucket rather than being forced into one.
    expect(deriveRunShape(null, 2)).toBe("unknown");
  });

  it("reads the cursor as a presence signal only, never parsing it", () => {
    expect(deriveRunShape("not-a-timestamp", 0)).toBe("warmNewDay");
  });
});

describe("buildUsageRunRecord: isFloor", () => {
  it("is false for a run where every call was measured and priced", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(summary, emptyContext({ expectedCalls: { triage: 1 } }), AT, "run-1");

    expect(record.isFloor).toBe(false);
    expect(record.totalBilledUsd).toBeGreaterThan(0);
  });

  it("is true from usage-less calls alone", () => {
    // Cause 1 in isolation: the call is priced fine and matches expectation,
    // it just never reported tokens.
    const summary = summarizeUsage(
      [{ stage: "triage", model: "claude-haiku-4-5", tokens: null }],
      AT
    );
    const record = buildUsageRunRecord(summary, emptyContext({ expectedCalls: { triage: 1 } }), AT, "run-1");

    expect(summary.unpricedModels).toEqual([]);
    expect(record.isFloor).toBe(true);
  });

  it("is true from a stage recording fewer calls than expected alone", () => {
    // Cause 2 in isolation: every recorded call reported usage and priced
    // cleanly -- but writeCard produced two cards and billed one call, so a
    // billed call went unrecorded entirely.
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5")], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ expectedCalls: { writeCard: 2 } }),
      AT,
      "run-1"
    );

    expect(summary.totalCallsWithoutUsage).toBe(0);
    expect(summary.unpricedModels).toEqual([]);
    expect(record.isFloor).toBe(true);
  });

  it("is true from an unpriced model alone", () => {
    // Cause 3 in isolation -- the late finding this flag exists for. The call
    // reported usage and matched expectation; there was simply no rate to
    // price it with, so its $0.000000 in the totals means UNKNOWN, not free.
    const table = { ...PRICING, "claude-sonnet-5": undefined } as unknown as Record<
      TrackedModel,
      ModelPricing
    >;
    const summary = summarizeUsage([call("writeCard", "claude-sonnet-5")], AT, table);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ expectedCalls: { writeCard: 1 } }),
      AT,
      "run-1"
    );

    expect(summary.totalCallsWithoutUsage).toBe(0);
    expect(summary.unpricedModels).toEqual(["claude-sonnet-5"]);
    expect(record.totalBilledUsd).toBe(0);
    expect(record.isFloor).toBe(true);
  });

  it("is not tripped by a stage that made MORE calls than expected", () => {
    // A retry is extra spend that WAS recorded. Calling that a floor would
    // mean the one run whose cost is fully known gets excluded from every
    // mean, which is the opposite of what the flag is for.
    const summary = summarizeUsage(
      [call("writeCard", "claude-sonnet-5"), call("writeCard", "claude-sonnet-5")],
      AT
    );
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ expectedCalls: { writeCard: 1 } }),
      AT,
      "run-1"
    );

    expect(record.isFloor).toBe(false);
  });

  it("sums a stage across models before comparing it against the expectation", () => {
    // writeCard genuinely mixes models in one run (Haiku for single-article
    // clusters, Sonnet for multi-source ones). Reading only the first group
    // would see 1 call against 2 expected and raise a false floor.
    const summary = summarizeUsage(
      [call("writeCard", "claude-sonnet-5"), call("writeCard", "claude-haiku-4-5")],
      AT
    );
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ expectedCalls: { writeCard: 2 } }),
      AT,
      "run-1"
    );

    expect(summary.stages).toHaveLength(2);
    expect(record.isFloor).toBe(false);
  });

  it("counts a usage-less call toward the expectation rather than twice-penalising it", () => {
    // A stage whose one billed call threw records as usage-less. That is a
    // floor (cause 1), but it must not ALSO read as an unrecorded call --
    // the call was recorded, its amount just isn't known.
    const summary = summarizeUsage(
      [{ stage: "expand", model: "claude-sonnet-5", tokens: null }],
      AT
    );
    const record = buildUsageRunRecord(summary, emptyContext({ expectedCalls: { expand: 1 } }), AT, "run-1");

    expect(record.isFloor).toBe(true);
    expect(record.totalCalls).toBe(0);
    expect(record.totalCallsWithoutUsage).toBe(1);
  });
});

describe("buildUsageRunRecord: the record itself", () => {
  it("keeps unmeasured context fields as null, never as zero", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    // toBeNull, not toBeFalsy: 0 is falsy, and 0 is precisely the value this
    // must never silently become. "The run exited before writing any cards"
    // and "the run wrote zero cards" are different facts and a mean that
    // swallowed the first would be wrong by an unknown amount.
    expect(record.articleCount).toBeNull();
    expect(record.clusterCount).toBeNull();
    expect(record.clustersAfterDedup).toBeNull();
    expect(record.notableCount).toBeNull();
    expect(record.cardsDroppedByCap).toBeNull();
    expect(record.cardsWritten).toBeNull();
    expect(record.cardsFailed).toBeNull();
    expect(record.topicCount).toBeNull();
    expect(record.sourceCount).toBeNull();
    expect(record.rankApplied).toBeNull();
    expect(record.cardId).toBeNull();
  });

  it("keeps a measured zero as zero and a failed-open rank as false", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ cardsWritten: 0, cardsFailed: 0, rankApplied: false }),
      AT,
      "run-1"
    );

    expect(record.cardsWritten).toBe(0);
    expect(record.cardsFailed).toBe(0);
    expect(record.rankApplied).toBe(false);
  });

  it("carries the priced instant, not the write time", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    expect(record.pricedAtIso).toBe("2026-09-11T12:00:00.000Z");
    expect(record.clockUsable).toBe(true);
  });

  it("records a null instant rather than throwing when the clock was unusable", () => {
    // toISOString() on an Invalid Date throws a RangeError, and this is built
    // inside a route's finally block -- a throw there would turn broken
    // instrumentation into a broken pipeline.
    const invalid = new Date("nonsense");
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], invalid);
    const record = buildUsageRunRecord(summary, emptyContext(), invalid, "run-1");

    expect(record.pricedAtIso).toBeNull();
    expect(record.clockUsable).toBe(false);
  });

  it("stamps the pricing verification date it was built under", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    expect(record.pricingVerifiedOn).toBe(PRICING_VERIFIED_ON);
    expect(record.schemaVersion).toBe(1);
  });

  it("flattens each (stage, model) group with its own priced flag", () => {
    const summary = summarizeUsage(
      [call("triage", "claude-haiku-4-5"), call("writeCard", "claude-sonnet-5")],
      AT
    );
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    expect(record.stages).toHaveLength(2);
    const writeCard = record.stages.find((s) => s.stage === "writeCard");
    expect(writeCard).toBeDefined();
    expect(writeCard!.model).toBe("claude-sonnet-5");
    expect(writeCard!.priced).toBe(true);
    expect(writeCard!.billedUsd).toBeGreaterThan(0);
    expect(writeCard!.tokens.inputTokens).toBe(1000);
  });

  it("does not carry expectedCalls onto the record", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(summary, emptyContext({ expectedCalls: { triage: 1 } }), AT, "run-1");

    expect("expectedCalls" in record).toBe(false);
  });

  it("copies the summary's arrays and token objects instead of aliasing them", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    summary.totalTokens.inputTokens = 999999;
    summary.stages[0].tokens.inputTokens = 999999;
    summary.unpricedModels.push("claude-sonnet-5");

    expect(record.totalTokens.inputTokens).toBe(1000);
    expect(record.stages[0].tokens.inputTokens).toBe(1000);
    expect(record.unpricedModels).toEqual([]);
  });
});

describe("toJsonlLine", () => {
  it("omits userId — the file lives in a public repo", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    const line = toJsonlLine(record);

    expect(line).not.toContain("user-1");
    expect(line).not.toContain("userId");
    expect(JSON.parse(line)).not.toHaveProperty("userId");
  });

  it("keeps everything else, including the fields a report segments on", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ runShape: "warmSameDay", outcome: "complete", cardsWritten: 4 }),
      AT,
      "run-1"
    );

    const parsed = JSON.parse(toJsonlLine(record));

    expect(parsed.runShape).toBe("warmSameDay");
    expect(parsed.route).toBe("digest");
    expect(parsed.outcome).toBe("complete");
    expect(parsed.cardsWritten).toBe(4);
    expect(parsed.isFloor).toBe(false);
    expect(parsed.stages).toHaveLength(1);
  });

  it("terminates the line itself so two records cannot fuse", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    const two = toJsonlLine(record) + toJsonlLine(record);

    expect(two.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
  });

  it("cannot split a record across lines when the label contains a newline", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(summary, emptyContext({ label: "a\nb" }), AT, "run-1");

    const line = toJsonlLine(record);

    expect(line.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(JSON.parse(line).label).toBe("a\nb");
  });

  it("round-trips the dollar figures without losing precision", () => {
    const summary = summarizeUsage(
      [call("writeCard", "claude-sonnet-5", usage(12345, 6789))],
      AT
    );
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    const parsed = JSON.parse(toJsonlLine(record));

    expect(parsed.totalBilledUsd).toBeCloseTo(record.totalBilledUsd, 10);
    expect(parsed.totalListUsd).toBeCloseTo(record.totalListUsd, 10);
    // And it is a real figure, not a coincidental pair of zeros.
    expect(record.totalBilledUsd).toBeGreaterThan(0);
  });
});

describe("toUsageRunRow", () => {
  it("maps onto the table's snake_case columns and keeps user_id", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ outcome: "complete", label: "digest complete", cardsWritten: 2, rankApplied: true }),
      AT,
      "run-1"
    );

    const row = toUsageRunRow(record);

    expect(row.id).toBe("run-1");
    expect(row.user_id).toBe("user-1");
    expect(row.schema_version).toBe(1);
    expect(row.route).toBe("digest");
    expect(row.digest_id).toBe("digest-1");
    expect(row.card_id).toBeNull();
    expect(row.priced_at).toBe("2026-09-11T12:00:00.000Z");
    expect(row.outcome).toBe("complete");
    expect(row.run_shape).toBe("cold");
    expect(row.cards_written).toBe(2);
    expect(row.rank_applied).toBe(true);
    expect(row.total_calls).toBe(1);
    expect(row.total_calls_without_usage).toBe(0);
    expect(row.is_floor).toBe(false);
    expect(row.clock_usable).toBe(true);
    expect(row.unpriced_models).toEqual([]);
    expect(row.pricing_verified_on).toBe(PRICING_VERIFIED_ON);
  });

  it("emits no camelCase key that Postgres would reject", () => {
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const row = toUsageRunRow(buildUsageRunRecord(summary, emptyContext(), AT, "run-1"));

    for (const key of Object.keys(row)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("passes dollars through as unrounded numbers for Postgres to round once", () => {
    const summary = summarizeUsage(
      [call("writeCard", "claude-sonnet-5", usage(12345, 6789))],
      AT
    );
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    const row = toUsageRunRow(record);

    expect(typeof row.total_billed_usd).toBe("number");
    expect(row.total_billed_usd).toBeCloseTo(record.totalBilledUsd, 10);
    expect(row.total_list_usd).toBeCloseTo(record.totalListUsd, 10);
  });

  it("carries a null priced_at rather than inventing an instant", () => {
    const invalid = new Date("nonsense");
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], invalid);
    const row = toUsageRunRow(buildUsageRunRecord(summary, emptyContext(), invalid, "run-1"));

    expect(row.priced_at).toBeNull();
    expect(row.clock_usable).toBe(false);
  });
});

describe("toUsageRunRow: every column carries its own field", () => {
  // The gap no type can close. `toUsageRunRow` writes `[COLUMN_OF.x]:
  // record.x` thirty times, and pairing one column with a DIFFERENT field of
  // a compatible type type-checks cleanly -- `[COLUMN_OF.pricedAtIso]:
  // record.outcome` compiles, because RunOutcome is assignable to
  // `string | null`. Found by mutating exactly that during review round 2,
  // where tsc reported nothing.
  //
  // The first version of this guard compared a REALISTIC record's values and
  // claimed distinctness made a mispairing impossible to miss. Round 3 broke
  // that claim twice independently: totalBilledUsd and totalListUsd both come
  // to 0.0015 for a promo-free call with no cache tokens, and schemaVersion,
  // topicCount and totalCalls were all 1. Swapping either pair compiled AND
  // passed.
  //
  // Distinctness is not merely hard to arrange here, it is impossible in
  // principle: three fields are booleans and there are two boolean values, so
  // some pair must always collide. A fixture of real values cannot carry this
  // guarantee, so the fixture below stops being realistic instead.
  it("pairs every field with its own column, proven by a unique sentinel per field", () => {
    // Every field holds a string naming itself, so two fields cannot share a
    // value by construction rather than by luck. toUsageRunRow only copies
    // values across -- it never inspects or computes on them -- so feeding it
    // sentinels exercises the real pairing logic, and the cast costs nothing.
    const sentinels = Object.fromEntries(
      Object.keys(COLUMN_OF).map((field) => [field, `sentinel:${field}`])
    ) as unknown as UsageRunRecord;

    const row = toUsageRunRow(sentinels) as Record<string, unknown>;

    for (const [field, column] of Object.entries(COLUMN_OF)) {
      expect({ column, value: row[column] }).toEqual({
        column,
        value: `sentinel:${field}`,
      });
    }
  });

  it("covers every field of the record, so the sentinel walk cannot miss one", () => {
    // Load-bearing for the test above: it iterates COLUMN_OF, so a field
    // missing from COLUMN_OF would be silently untested there. (COLUMN_OF's
    // `satisfies` already makes that a compile error -- this is the runtime
    // half, and it is what keeps the sentinel walk's coverage honest if that
    // constraint is ever loosened.)
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(summary, emptyContext(), AT, "run-1");

    expect(new Set(Object.keys(COLUMN_OF))).toEqual(new Set(Object.keys(record)));
  });

  it("carries real values through unchanged, not just sentinels", () => {
    // The sentinel test proves the WIRING; this proves real data survives the
    // trip, including the null-vs-zero distinction and a nested object.
    const summary = summarizeUsage([call("triage", "claude-haiku-4-5")], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ outcome: "complete", cardsWritten: 8, cardsFailed: 0, articleCount: null }),
      AT,
      "run-1"
    );

    const row = toUsageRunRow(record);

    expect(row.cards_written).toBe(8);
    expect(row.cards_failed).toBe(0);
    expect(row.article_count).toBeNull();
    expect(row.total_tokens).toEqual(record.totalTokens);
    expect(row.stages).toEqual(record.stages);
  });
});
