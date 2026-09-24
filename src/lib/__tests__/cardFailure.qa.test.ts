import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { GenerationRejectedError, REJECTED_TAIL_CHARS } from "@/lib/claudeText";
import { classifyCardFailure } from "@/lib/cardFailure";
import {
  buildUsageRunRecord,
  toJsonlLine,
  toUsageRunRow,
  type UsageRunContext,
} from "@/lib/usageRecord";
import { summarizeUsage } from "@/lib/usage";

const AT = new Date("2026-09-24T12:00:00Z");

function emptyContext(overrides: Partial<UsageRunContext> = {}): UsageRunContext {
  return {
    userId: "user-1",
    route: "digest",
    digestId: "digest-1",
    cardId: null,
    outcome: "complete",
    label: "digest complete",
    runShape: "firstOfDay",
    topicCount: null,
    sourceCount: null,
    articleCount: null,
    clusterCount: null,
    clustersAfterDedup: null,
    notableCount: null,
    cardsDroppedByCap: null,
    cardsWritten: null,
    cardsFailed: null,
    cardFailures: null,
    triageFailedClosed: null,
    rankApplied: null,
    expectedCalls: {},
    ...overrides,
  };
}

describe("classifyCardFailure: adversarial inputs", () => {
  it("does not throw and falls back to `other` for a thrown null (typeof null is \"object\", same as a plain object)", () => {
    expect(classifyCardFailure(null, "claude-haiku-4-5", 1)).toEqual({
      reason: "other",
      model: "claude-haiku-4-5",
      articleCount: 1,
      errorName: "object",
    });
  });

  it("does not throw and falls back to `other` for a thrown undefined", () => {
    expect(classifyCardFailure(undefined, "claude-haiku-4-5", 1)).toEqual({
      reason: "other",
      model: "claude-haiku-4-5",
      articleCount: 1,
      errorName: "undefined",
    });
  });

  it("falls back to `other` for a plain object with no name/message, not a subclass", () => {
    const failure = classifyCardFailure({ weird: true }, "claude-sonnet-5", 2);
    expect(failure.reason).toBe("other");
    expect(failure.errorName).toBe("object");
  });

  it("recognizes an Anthropic.APIError SUBCLASS (e.g. a rate-limit error) as apiError, not `other`", () => {
    // Anthropic's SDK throws named subclasses (RateLimitError,
    // AuthenticationError, etc.), all extending APIError. classifyCardFailure
    // must match on the base class, not a specific named one, or a real
    // rate-limit failure would be misclassified as `other` with no status.
    const err = new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers());
    const failure = classifyCardFailure(err, "claude-haiku-4-5", 1);
    expect(failure.reason).toBe("apiError");
    expect(failure.status).toBe(429);
  });

  it("keeps a custom Error subclass's name distinct from GenerationRejectedError's", () => {
    class WeirdError extends Error {
      constructor() {
        super("weird");
        this.name = "WeirdError";
      }
    }
    const failure = classifyCardFailure(new WeirdError(), "claude-sonnet-5", 1);
    expect(failure).toEqual({
      reason: "other",
      model: "claude-sonnet-5",
      articleCount: 1,
      errorName: "WeirdError",
    });
  });

  it("tail equals the whole text when the text is shorter than the tail window", () => {
    const err = new GenerationRejectedError("m", "empty", "end_turn", "short");
    expect(err.tail).toBe("short");
    expect(err.tail.length).toBeLessThan(REJECTED_TAIL_CHARS);
  });

  it("tail is empty for a genuinely empty rejected text", () => {
    const err = new GenerationRejectedError("m", "empty", "end_turn", "");
    expect(err.tail).toBe("");
    const failure = classifyCardFailure(err, "claude-haiku-4-5", 1);
    expect(failure.tail).toBe("");
  });

  it("tail is exactly the boundary-length text unchanged, not off by one", () => {
    const text = "x".repeat(REJECTED_TAIL_CHARS);
    const err = new GenerationRejectedError("m", "truncated", "max_tokens", text);
    expect(err.tail).toBe(text);
    expect(err.tail).toHaveLength(REJECTED_TAIL_CHARS);
  });
});

describe("cardFailures survives the JSONL line and the Supabase row intact", () => {
  const failures = [
    {
      reason: "truncated" as const,
      model: "claude-sonnet-5" as const,
      articleCount: 2,
      stopReason: "max_tokens",
      // Deliberately carries a raw newline, an em dash and a double quote --
      // exactly the characters that would fuse or split a hand-rolled JSONL
      // line. JSON.stringify must escape all three so the record stays one
      // line and round-trips exactly.
      tail: 'ends mid-sentence —\nwith a "quote" and a line break',
    },
    {
      reason: "apiError" as const,
      model: "claude-haiku-4-5" as const,
      articleCount: 1,
      status: 529,
    },
    {
      reason: "other" as const,
      model: "claude-haiku-4-5" as const,
      articleCount: 1,
      errorName: "TypeError",
    },
  ];

  it("round-trips the full cardFailures array through toJsonlLine as exactly one line", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ cardsFailed: 3, cardFailures: failures, triageFailedClosed: 2 }),
      AT,
      "run-1"
    );

    const line = toJsonlLine(record);

    expect(line.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    const parsed = JSON.parse(line);
    expect(parsed.cardFailures).toEqual(failures);
    expect(parsed.triageFailedClosed).toBe(2);
  });

  it("carries the array onto the Supabase row under card_failures, unserialized (object, not a JSON string)", () => {
    const summary = summarizeUsage([], AT);
    const record = buildUsageRunRecord(
      summary,
      emptyContext({ cardsFailed: 3, cardFailures: failures, triageFailedClosed: 2 }),
      AT,
      "run-1"
    );

    const row = toUsageRunRow(record);

    expect(row.card_failures).toEqual(failures);
    expect(Array.isArray(row.card_failures)).toBe(true);
    expect(row.triage_failed_closed).toBe(2);
  });

  it("keeps null distinct from an empty array on both the JSONL line and the row", () => {
    const summary = summarizeUsage([], AT);
    const endedEarly = buildUsageRunRecord(
      summary,
      emptyContext({ outcome: "endedEarly", cardFailures: null, triageFailedClosed: null }),
      AT,
      "run-1"
    );
    const cleanRun = buildUsageRunRecord(
      summary,
      emptyContext({ cardFailures: [], triageFailedClosed: 0 }),
      AT,
      "run-2"
    );

    expect(JSON.parse(toJsonlLine(endedEarly)).cardFailures).toBeNull();
    expect(JSON.parse(toJsonlLine(cleanRun)).cardFailures).toEqual([]);
    expect(toUsageRunRow(endedEarly).card_failures).toBeNull();
    expect(toUsageRunRow(cleanRun).card_failures).toEqual([]);
  });
});
