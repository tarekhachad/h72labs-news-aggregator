import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  GenerationRejectedError,
  REJECTED_TAIL_CHARS,
  generateWithRetryOnAmbiguousTruncation,
} from "@/lib/claudeText";
import { classifyCardFailure } from "@/lib/cardFailure";

// A card lost to a refused response and a card lost to an API error need
// different fixes, and the stored record is the only place that can tell
// them apart once the runtime logs expire. These pin that each throw site
// says which one it was, and that the classifier keeps the distinction.

function gen(text: string, stopReason: string | null = "end_turn") {
  return async () => ({ text, stopReason });
}

async function rejection(generate: () => Promise<{ text: string; stopReason: string | null }>) {
  try {
    await generateWithRetryOnAmbiguousTruncation(generate, "writeCard");
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("generateWithRetryOnAmbiguousTruncation: typed rejections", () => {
  it("marks empty output as `empty`, keeping the message the logs already search for", async () => {
    const err = await rejection(gen("   ", "end_turn"));
    expect(err).toBeInstanceOf(GenerationRejectedError);
    expect(err).toMatchObject({ reason: "empty", stopReason: "end_turn", name: "GenerationRejectedError" });
    expect((err as Error).message).toMatch(/^writeCard produced empty output/);
  });

  it("marks a cut-off response with a non-end_turn stop as `truncated`", async () => {
    const err = await rejection(gen("This stops mid", "max_tokens"));
    expect(err).toMatchObject({ reason: "truncated", stopReason: "max_tokens", tail: "This stops mid" });
    expect((err as Error).message).toMatch(/produced a truncated output/);
  });

  it("marks a response that still looks incomplete after its retry as `incompleteAfterRetry`, with the RETRY's text", async () => {
    let calls = 0;
    const err = await rejection(async () => {
      calls += 1;
      return { text: calls === 1 ? "first attempt" : "second attempt", stopReason: "end_turn" };
    });
    expect(calls).toBe(2);
    expect(err).toMatchObject({ reason: "incompleteAfterRetry", tail: "second attempt" });
    expect((err as Error).message).toMatch(/incomplete output even after retry/);
  });

  it("keeps only the end of a long rejected text", async () => {
    const text = "x".repeat(500) + " and it ends here";
    const err = (await rejection(gen(text, "max_tokens"))) as GenerationRejectedError;
    expect(err.tail).toHaveLength(REJECTED_TAIL_CHARS);
    expect(text.endsWith(err.tail)).toBe(true);
  });

  it("does not reject a complete response", async () => {
    await expect(
      generateWithRetryOnAmbiguousTruncation(gen("A full sentence."), "writeCard")
    ).resolves.toMatchObject({ text: "A full sentence." });
  });
});

describe("classifyCardFailure", () => {
  it("carries a rejection's reason, stop reason and tail", () => {
    const err = new GenerationRejectedError("m", "incompleteAfterRetry", "end_turn", "ends oddly");
    expect(classifyCardFailure(err, "claude-sonnet-5", 3)).toEqual({
      reason: "incompleteAfterRetry",
      model: "claude-sonnet-5",
      articleCount: 3,
      stopReason: "end_turn",
      tail: "ends oddly",
    });
  });

  it("records an API error with its HTTP status", () => {
    const err = new Anthropic.APIError(529, undefined, "overloaded", new Headers());
    expect(classifyCardFailure(err, "claude-haiku-4-5", 1)).toEqual({
      reason: "apiError",
      model: "claude-haiku-4-5",
      articleCount: 1,
      status: 529,
    });
  });

  it("records a connection failure as an API error with no status", () => {
    const err = new Anthropic.APIConnectionError({ message: "socket hang up" });
    const failure = classifyCardFailure(err, "claude-haiku-4-5", 1);
    expect(failure.reason).toBe("apiError");
    expect(failure).not.toHaveProperty("status");
  });

  it("falls back to `other` with the error's name for anything else", () => {
    expect(classifyCardFailure(new TypeError("boom"), "claude-haiku-4-5", 1)).toEqual({
      reason: "other",
      model: "claude-haiku-4-5",
      articleCount: 1,
      errorName: "TypeError",
    });
    expect(classifyCardFailure("a string", "claude-haiku-4-5", 1).errorName).toBe("string");
  });
});
