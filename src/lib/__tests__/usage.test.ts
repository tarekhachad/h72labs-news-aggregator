import { describe, expect, it } from "vitest";
import {
  PRICING,
  PRICING_VERIFIED_ON,
  TRACKED_MODELS,
  addTokens,
  costFor,
  formatCallLine,
  formatUsageSummary,
  formatUsd,
  normalizeUsage,
  summarizeUsage,
  type CallTokens,
  type RecordedCall,
} from "@/lib/usage";

/** Mid-promo. Every test that doesn't care about the boundary uses this. */
const DURING_PROMO = new Date("2026-08-13T12:00:00Z");

function tokens(partial: Partial<CallTokens>): CallTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  };
}

describe("PRICING", () => {
  it("prices every tracked model", () => {
    // Guards the Record<TrackedModel, ...> invariant at runtime too: a model
    // added to TRACKED_MODELS without a price is a tsc error, but this also
    // catches a stray extra key.
    expect(Object.keys(PRICING).sort()).toEqual([...TRACKED_MODELS].sort());
  });

  it("records when the rates were last verified", () => {
    expect(PRICING_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("costFor", () => {
  it("prices plain input and output tokens", () => {
    // Haiku: $1.00/MTok in, $5.00/MTok out.
    const cost = costFor(
      "claude-haiku-4-5",
      tokens({ inputTokens: 1000, outputTokens: 1000 }),
      DURING_PROMO
    );
    expect(cost.billedUsd).toBeCloseTo(0.006, 10);
    // Haiku has no promo, so billed and list are the same number.
    expect(cost.listUsd).toBeCloseTo(0.006, 10);
    expect(cost.promoApplied).toBe(false);
    expect(cost.promoEndsOn).toBeNull();
  });

  it("prices cache reads at 0.1x the input rate", () => {
    const cost = costFor("claude-haiku-4-5", tokens({ cacheReadTokens: 10_000 }), DURING_PROMO);
    expect(cost.billedUsd).toBeCloseTo(0.001, 10);
  });

  it("prices cache writes at 1.25x the input rate", () => {
    const cost = costFor("claude-haiku-4-5", tokens({ cacheWriteTokens: 10_000 }), DURING_PROMO);
    expect(cost.billedUsd).toBeCloseTo(0.0125, 10);
  });

  it("applies Sonnet's introductory rate while it is live", () => {
    const cost = costFor(
      "claude-sonnet-5",
      tokens({ inputTokens: 1000, outputTokens: 1000 }),
      DURING_PROMO
    );
    // Intro $2/$10 vs list $3/$15.
    expect(cost.billedUsd).toBeCloseTo(0.012, 10);
    expect(cost.listUsd).toBeCloseTo(0.018, 10);
    expect(cost.promoApplied).toBe(true);
    expect(cost.promoEndsOn).toBe("2026-08-31");
  });

  // The anti-stale pair. These are why costFor takes an explicit `at` instead
  // of reading the clock: the boundary is asserted at the exact second it
  // flips, not only on the day someone happens to run the suite.
  it("treats the promo's last day as inclusive", () => {
    const cost = costFor(
      "claude-sonnet-5",
      tokens({ inputTokens: 1000, outputTokens: 1000 }),
      new Date("2026-08-31T23:59:59Z")
    );
    expect(cost.promoApplied).toBe(true);
    expect(cost.billedUsd).toBeCloseTo(0.012, 10);
  });

  it("falls back to list price the instant the promo lapses", () => {
    const cost = costFor(
      "claude-sonnet-5",
      tokens({ inputTokens: 1000, outputTokens: 1000 }),
      new Date("2026-09-01T00:00:00Z")
    );
    expect(cost.promoApplied).toBe(false);
    expect(cost.billedUsd).toBe(cost.listUsd);
    expect(cost.billedUsd).toBeCloseTo(0.018, 10);
    // Still reported, so a reader can see which promo lapsed and when.
    expect(cost.promoEndsOn).toBe("2026-08-31");
  });

  // The window is closed at both ends. An open-ended start would hand a
  // discount to any implausibly early date and report billed < list with
  // nothing flagged — a figure below the real bill, silently. Pinned at the
  // real edge, not with a far-past date: 1970 alone would pass even if the
  // comparison were off by one.
  it("treats the promo's first day as inclusive", () => {
    const cost = costFor(
      "claude-sonnet-5",
      tokens({ inputTokens: 1000, outputTokens: 1000 }),
      new Date("2026-01-01T00:00:00Z")
    );
    expect(cost.promoApplied).toBe(true);
    expect(cost.billedUsd).toBeCloseTo(0.012, 10);
  });

  it("does not apply the promo to the instant before its window opens", () => {
    const cost = costFor(
      "claude-sonnet-5",
      tokens({ inputTokens: 1000, outputTokens: 1000 }),
      new Date("2025-12-31T23:59:59Z")
    );
    expect(cost.promoApplied).toBe(false);
    expect(cost.billedUsd).toBe(cost.listUsd);
  });

  it("does not apply the promo to a date far outside its window", () => {
    const cost = costFor(
      "claude-sonnet-5",
      tokens({ inputTokens: 1000, outputTokens: 1000 }),
      new Date("1970-01-01T00:00:00Z")
    );
    expect(cost.promoApplied).toBe(false);
    expect(cost.billedUsd).toBe(cost.listUsd);
  });
});

describe("normalizeUsage", () => {
  // These four are the contract that keeps ~30 pre-existing tests passing:
  // their mocked responses carry no `usage` field at all.
  it("returns null rather than zeros when usage is missing", () => {
    expect(normalizeUsage(undefined)).toBeNull();
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({})).toBeNull();
  });

  it("returns null for a non-object", () => {
    expect(normalizeUsage("120 tokens")).toBeNull();
    expect(normalizeUsage(42)).toBeNull();
  });

  it("returns null when a required count is not a finite number", () => {
    expect(normalizeUsage({ input_tokens: 5 })).toBeNull();
    expect(normalizeUsage({ input_tokens: 5, output_tokens: null })).toBeNull();
    expect(normalizeUsage({ input_tokens: NaN, output_tokens: 2 })).toBeNull();
  });

  it("treats absent or null cache fields as zero", () => {
    // The SDK types both cache fields as `number | null`, so this is the
    // ordinary shape for a call that doesn't use prompt caching — which is
    // every call this app makes today.
    expect(normalizeUsage({ input_tokens: 5, output_tokens: 2 })).toEqual(
      tokens({ inputTokens: 5, outputTokens: 2 })
    );
    expect(
      normalizeUsage({
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      })
    ).toEqual(tokens({ inputTokens: 5, outputTokens: 2 }));
  });

  // The boundary the whole module turns on: a real zero is data, an absent
  // count is not. These must not collapse into the same result.
  it("returns real zeros for a usage object that genuinely reports zero", () => {
    expect(normalizeUsage({ input_tokens: 0, output_tokens: 0 })).toEqual(tokens({}));
  });

  it("rejects negative counts rather than subtracting them from a total", () => {
    // A negative would look like measured data while pulling the total below
    // the real bill — the exact failure the null contract exists to prevent.
    expect(normalizeUsage({ input_tokens: -5, output_tokens: 2 })).toBeNull();
    expect(normalizeUsage({ input_tokens: 5, output_tokens: -2 })).toBeNull();
  });

  it("rejects an invalid cache count too, rather than quietly zeroing it", () => {
    // Zeroing would leave the call counted as fully measured while its real
    // cache spend went missing — the same understatement a negative
    // input_tokens is rejected for, so it's rejected the same way.
    expect(
      normalizeUsage({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: -100 })
    ).toBeNull();
    expect(
      normalizeUsage({ input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: "lots" })
    ).toBeNull();
  });

  // Asserted with Object.is on every field, not toEqual: toEqual treats -0
  // and 0 as equal, so a regression that dropped the normalization would
  // pass the rest of this suite silently.
  it("normalizes a signed zero on every count so it can never reach a total", () => {
    const result = normalizeUsage({
      input_tokens: -0,
      output_tokens: -0,
      cache_read_input_tokens: -0,
      cache_creation_input_tokens: -0,
    });
    expect(Object.is(result?.inputTokens, 0)).toBe(true);
    expect(Object.is(result?.outputTokens, 0)).toBe(true);
    expect(Object.is(result?.cacheReadTokens, 0)).toBe(true);
    expect(Object.is(result?.cacheWriteTokens, 0)).toBe(true);
  });

  it("ignores inherited properties so a polluted prototype can't fake usage", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto.input_tokens = 999_999;
      proto.output_tokens = 999_999;
      expect(normalizeUsage({})).toBeNull();
    } finally {
      delete proto.input_tokens;
      delete proto.output_tokens;
    }
  });

  it("ignores an inherited cache count as well as the required ones", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto.cache_read_input_tokens = 999_999;
      expect(normalizeUsage({ input_tokens: 5, output_tokens: 2 })).toEqual(
        tokens({ inputTokens: 5, outputTokens: 2 })
      );
    } finally {
      delete proto.cache_read_input_tokens;
    }
  });

  it("reads all four counts when present", () => {
    expect(
      normalizeUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 3,
      })
    ).toEqual(
      tokens({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheWriteTokens: 3 })
    );
  });
});

describe("addTokens", () => {
  it("sums every field", () => {
    expect(
      addTokens(
        tokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
        tokens({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 })
      )
    ).toEqual(
      tokens({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 })
    );
  });
});

describe("summarizeUsage", () => {
  const call = (
    stage: RecordedCall["stage"],
    model: RecordedCall["model"],
    t: CallTokens | null
  ): RecordedCall => ({ stage, model, tokens: t });

  it("groups by stage and sums tokens", () => {
    const summary = summarizeUsage(
      [
        call("triage", "claude-haiku-4-5", tokens({ inputTokens: 100, outputTokens: 10 })),
        call("triage", "claude-haiku-4-5", tokens({ inputTokens: 200, outputTokens: 20 })),
        call("writeCard", "claude-sonnet-5", tokens({ inputTokens: 1000, outputTokens: 300 })),
      ],
      DURING_PROMO
    );

    expect(summary.stages).toHaveLength(2);
    const triage = summary.stages.find((s) => s.stage === "triage");
    expect(triage?.calls).toBe(2);
    expect(triage?.tokens).toEqual(tokens({ inputTokens: 300, outputTokens: 30 }));
    expect(summary.totalCalls).toBe(3);
    expect(summary.totalTokens).toEqual(tokens({ inputTokens: 1300, outputTokens: 330 }));
  });

  // Pins the (stage, model) grouping. Every stage uses one model today, so
  // this is the only place the distinction is exercised — and summing tokens
  // across two models then pricing them once would be wrong by up to 3x.
  it("keeps a stage's models in separate groups so each is priced at its own rate", () => {
    const summary = summarizeUsage(
      [
        call("triage", "claude-haiku-4-5", tokens({ inputTokens: 1000, outputTokens: 1000 })),
        call("triage", "claude-sonnet-5", tokens({ inputTokens: 1000, outputTokens: 1000 })),
      ],
      DURING_PROMO
    );

    expect(summary.stages).toHaveLength(2);
    expect(summary.totalBilledUsd).toBeCloseTo(0.006 + 0.012, 10);
    expect(summary.totalListUsd).toBeCloseTo(0.006 + 0.018, 10);
  });

  it("counts usage-less calls separately and excludes them from token totals", () => {
    const summary = summarizeUsage(
      [
        call("writeCard", "claude-sonnet-5", tokens({ inputTokens: 1000, outputTokens: 1000 })),
        call("writeCard", "claude-sonnet-5", null),
      ],
      DURING_PROMO
    );

    const stage = summary.stages[0];
    expect(stage.calls).toBe(1);
    expect(stage.callsWithoutUsage).toBe(1);
    expect(summary.totalCalls).toBe(1);
    expect(summary.totalCallsWithoutUsage).toBe(1);
    expect(summary.totalTokens).toEqual(tokens({ inputTokens: 1000, outputTokens: 1000 }));
  });

  it("reports whether the promo was actually applied to this run", () => {
    const calls = [call("writeCard", "claude-sonnet-5", tokens({ inputTokens: 10 }))];
    expect(summarizeUsage(calls, DURING_PROMO).promos).toEqual([
      { model: "claude-sonnet-5", endsOn: "2026-08-31", applied: true },
    ]);
    expect(summarizeUsage(calls, new Date("2026-09-01T00:00:00Z")).promos).toEqual([
      { model: "claude-sonnet-5", endsOn: "2026-08-31", applied: false },
    ]);
  });

  it("reports a promoted model once, however many stages used it", () => {
    const summary = summarizeUsage(
      [
        call("writeCard", "claude-sonnet-5", tokens({ inputTokens: 10 })),
        call("expand", "claude-sonnet-5", tokens({ inputTokens: 10 })),
      ],
      DURING_PROMO
    );
    expect(summary.promos).toHaveLength(1);
  });

  it("reports no promo for a run that only used Haiku", () => {
    const summary = summarizeUsage(
      [call("triage", "claude-haiku-4-5", tokens({ inputTokens: 10 }))],
      DURING_PROMO
    );
    expect(summary.promos).toEqual([]);
  });

  it("handles an empty call list", () => {
    const summary = summarizeUsage([], DURING_PROMO);
    expect(summary.stages).toEqual([]);
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalBilledUsd).toBe(0);
    expect(summary.promos).toEqual([]);
  });

  it("does not mutate the calls it is given", () => {
    const input = Object.freeze([
      call("triage", "claude-haiku-4-5", Object.freeze(tokens({ inputTokens: 10 })) as CallTokens),
    ]) as unknown as RecordedCall[];
    expect(() => summarizeUsage(input, DURING_PROMO)).not.toThrow();
  });

  // A bad clock must not crash the cost report, and must never make a run
  // look cheaper than it was. Pricing at list is the safe direction.
  it("prices at list rather than throwing when the date is unusable", () => {
    const summary = summarizeUsage(
      [
        call("writeCard", "claude-sonnet-5", tokens({ inputTokens: 1000, outputTokens: 1000 })),
        call("triage", "claude-haiku-4-5", tokens({ inputTokens: 1000, outputTokens: 1000 })),
      ],
      new Date(NaN)
    );
    expect(summary.totalBilledUsd).toBe(summary.totalListUsd);
    expect(summary.promos[0].applied).toBe(false);
  });
});

describe("formatUsd", () => {
  it("uses six decimal places, since a triage call costs about $0.0015", () => {
    expect(formatUsd(0.0015)).toBe("$0.001500");
    expect(formatUsd(0)).toBe("$0.000000");
  });

  it("never renders a nonzero cost as exactly zero", () => {
    // Rounding a real charge down to "$0.000000" would claim a call was free.
    expect(formatUsd(0.0000004)).toBe("<$0.000001");
  });
});

describe("formatCallLine", () => {
  it("reports every token count and the billed cost", () => {
    const line = formatCallLine(
      {
        stage: "triage",
        model: "claude-haiku-4-5",
        tokens: tokens({ inputTokens: 1180, outputTokens: 48 }),
      },
      DURING_PROMO
    );
    expect(line).toContain("[usage] triage claude-haiku-4-5");
    expect(line).toContain("in=1180");
    expect(line).toContain("out=48");
    expect(line).toContain("$0.001420");
  });

  it("says so plainly when a call reported no usage", () => {
    const line = formatCallLine(
      { stage: "writeCard", model: "claude-sonnet-5", tokens: null },
      DURING_PROMO
    );
    expect(line).toContain("no usage reported");
    // Must not invent a dollar figure for a call whose cost is unknown.
    expect(line).not.toContain("$");
  });
});

describe("formatUsageSummary", () => {
  const someCalls: RecordedCall[] = [
    {
      stage: "triage",
      model: "claude-haiku-4-5",
      tokens: tokens({ inputTokens: 1000, outputTokens: 100 }),
    },
    {
      stage: "writeCard",
      model: "claude-sonnet-5",
      tokens: tokens({ inputTokens: 2000, outputTokens: 300 }),
    },
  ];

  it("renders a per-stage table with both billed and list columns", () => {
    const lines = formatUsageSummary(summarizeUsage(someCalls, DURING_PROMO), {
      label: "digest complete",
    });
    const text = lines.join("\n");

    expect(lines[0]).toContain("digest complete — 2 calls");
    expect(text).toContain("triage");
    expect(text).toContain("writeCard");
    expect(text).toContain("TOTAL");
    expect(text).toContain("billed");
    expect(text).toContain("at list");
    expect(lines.every((line) => line.startsWith("[usage]"))).toBe(true);
  });

  it("explains the introductory rate while it is live", () => {
    const text = formatUsageSummary(summarizeUsage(someCalls, DURING_PROMO), {
      label: "digest complete",
    }).join("\n");
    expect(text).toContain("introductory pricing was in effect for this run and ends 2026-08-31");
    expect(text).toContain(PRICING_VERIFIED_ON);
  });

  it("says the promo is not in effect once it has lapsed", () => {
    const text = formatUsageSummary(summarizeUsage(someCalls, new Date("2026-09-15T00:00:00Z")), {
      label: "digest complete",
    }).join("\n");
    expect(text).toContain("is not in effect for this run");
    expect(text).toContain("billed is list price");
    expect(text).not.toContain("was in effect for this run");
  });

  it("labels the totals a floor when any call reported no usage", () => {
    const text = formatUsageSummary(
      summarizeUsage(
        [...someCalls, { stage: "triage", model: "claude-haiku-4-5", tokens: null }],
        DURING_PROMO
      ),
      { label: "digest complete" }
    ).join("\n");

    expect(text).toContain("WARNING");
    expect(text).toContain("FLOOR");
    // The affected stage's cell shows the unmeasured call rather than hiding it.
    expect(text).toContain("1+1?");
  });

  it("omits the floor warning when every call reported usage", () => {
    const text = formatUsageSummary(summarizeUsage(someCalls, DURING_PROMO), {
      label: "digest complete",
    }).join("\n");
    expect(text).not.toContain("FLOOR");
  });

  // Surfaces claudeText.ts's ambiguous-truncation retry, which bills twice
  // for one card, without anyone having to read the code.
  it("flags a stage that made more calls than the work it produced", () => {
    const calls: RecordedCall[] = Array.from({ length: 6 }, () => ({
      stage: "writeCard" as const,
      model: "claude-sonnet-5" as const,
      tokens: tokens({ inputTokens: 100, outputTokens: 10 }),
    }));
    const text = formatUsageSummary(summarizeUsage(calls, DURING_PROMO), {
      label: "digest complete",
      expectedCalls: { writeCard: 5 },
    }).join("\n");

    expect(text).toContain("writeCard made 6 calls for 5");
    expect(text).toContain("1 extra billed attempt(s)");
  });

  it("does not flag a stage whose call count matches the work produced", () => {
    const calls: RecordedCall[] = Array.from({ length: 5 }, () => ({
      stage: "writeCard" as const,
      model: "claude-sonnet-5" as const,
      tokens: tokens({ inputTokens: 100, outputTokens: 10 }),
    }));
    const text = formatUsageSummary(summarizeUsage(calls, DURING_PROMO), {
      label: "digest complete",
      expectedCalls: { writeCard: 5 },
    }).join("\n");
    expect(text).not.toContain("extra billed attempt");
  });

  // The mirror of the extra-attempt line, and the more dangerous direction:
  // a stage that recorded fewer calls than the work it did produces a total
  // that is confidently low with nothing to signal it.
  it("warns when a stage recorded fewer calls than expected", () => {
    const calls: RecordedCall[] = Array.from({ length: 2 }, () => ({
      stage: "writeCard" as const,
      model: "claude-sonnet-5" as const,
      tokens: tokens({ inputTokens: 100, outputTokens: 10 }),
    }));
    const text = formatUsageSummary(summarizeUsage(calls, DURING_PROMO), {
      label: "digest complete",
      expectedCalls: { writeCard: 5 },
    }).join("\n");

    expect(text).toContain("WARNING");
    expect(text).toContain("recorded 2 calls but 5 were expected");
    expect(text).toContain("FLOOR");
  });

  it("says nothing about a stage that was expected to make no calls and made none", () => {
    const text = formatUsageSummary(
      summarizeUsage(
        [{ stage: "triage", model: "claude-haiku-4-5", tokens: tokens({ inputTokens: 10 }) }],
        DURING_PROMO
      ),
      { label: "digest complete", expectedCalls: { dedup: 0 } }
    ).join("\n");

    expect(text).not.toContain("dedup");
  });

  it("counts a stage's calls across every model it used", () => {
    // summarizeUsage splits a stage by model; the expectedCalls check must
    // sum those groups rather than reading only the first one.
    const text = formatUsageSummary(
      summarizeUsage(
        [
          { stage: "writeCard", model: "claude-sonnet-5", tokens: tokens({ inputTokens: 10 }) },
          { stage: "writeCard", model: "claude-haiku-4-5", tokens: tokens({ inputTokens: 10 }) },
        ],
        DURING_PROMO
      ),
      { label: "digest complete", expectedCalls: { writeCard: 2 } }
    ).join("\n");

    expect(text).not.toContain("extra billed attempt");
    expect(text).not.toContain("were expected");
  });

  it("warns loudly when work happened but nothing was recorded", () => {
    // The instrumentation-is-broken alarm: cards exist, so calls were
    // definitely billed, yet the collector saw none. Without this the run
    // would report a confident and completely wrong $0.00.
    const text = formatUsageSummary(summarizeUsage([], DURING_PROMO), {
      label: "digest complete",
      expectedCalls: { writeCard: 5 },
    }).join("\n");

    expect(text).toContain("WARNING");
    expect(text).toContain("Instrumentation is not wired up");
  });

  it("reports a genuinely free run as free", () => {
    const text = formatUsageSummary(summarizeUsage([], DURING_PROMO), {
      label: "digest complete",
    }).join("\n");
    expect(text).toContain("0 calls. No Claude spend this run.");
    expect(text).not.toContain("WARNING");
  });
});
