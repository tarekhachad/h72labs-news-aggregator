import { describe, it, expect } from "vitest";
import { RUN_FAILED_MESSAGE, WholeRunFailure, everyCardFailed, everyTriageFailed } from "@/lib/runFailure";
import type { CardFailure } from "@/lib/cardFailure";

const apiError: CardFailure = { reason: "apiError", model: "claude-haiku-4-5", articleCount: 1, status: 400 };
const refused: CardFailure = { reason: "incompleteAfterRetry", model: "claude-sonnet-5", articleCount: 2, stopReason: "end_turn", tail: "…" };
const unknown: CardFailure = { reason: "other", model: "claude-haiku-4-5", articleCount: 1, errorName: "Error" };

describe("everyTriageFailed", () => {
  it("is true only when every triaged cluster failed closed", () => {
    expect(everyTriageFailed(3, 3)).toBe(true);
    expect(everyTriageFailed(3, 2)).toBe(false);
    expect(everyTriageFailed(1, 0)).toBe(false);
  });

  it("treats a run with nothing to triage as quiet, not failed", () => {
    expect(everyTriageFailed(0, 0)).toBe(false);
  });
});

describe("everyCardFailed", () => {
  it("is true when every attempted card failed with an API error", () => {
    expect(everyCardFailed(2, [apiError, apiError])).toBe(true);
  });

  it("is false when any card was written", () => {
    expect(everyCardFailed(2, [apiError])).toBe(false);
  });

  it("is false with nothing attempted", () => {
    expect(everyCardFailed(0, [])).toBe(false);
  });

  it("is false when a failure was a response the app refused, which a retry tends to repeat", () => {
    expect(everyCardFailed(1, [refused])).toBe(false);
    expect(everyCardFailed(2, [apiError, refused])).toBe(false);
  });

  it("is false for an unclassified failure", () => {
    expect(everyCardFailed(1, [unknown])).toBe(false);
  });
});

describe("WholeRunFailure", () => {
  it("keeps the detail for the log and a fixed message for the reader", () => {
    const err = new WholeRunFailure("every triage call failed (3/3 clusters unjudged)");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("every triage call failed (3/3 clusters unjudged)");
    expect(err.readerMessage).toBe(RUN_FAILED_MESSAGE);
    expect(err.name).toBe("WholeRunFailure");
  });
});
