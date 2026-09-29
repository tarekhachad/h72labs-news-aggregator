import { describe, it, expect, vi } from "vitest";
import {
  generateWithRetryOnAmbiguousTruncation,
  looksComplete,
} from "@/lib/claudeText";

describe("looksComplete", () => {
  it.each([
    "He called it a disgrace.",
    'He called it "a disgrace."',
    "He called it 'a disgrace.'",
    "He called it “a disgrace.”",
    "Was it “a disgrace?”",
    "She said ‘never again!’",
    "It passed (narrowly.)",
  ])("accepts a finished sentence: %s", (text) => {
    expect(looksComplete(text)).toBe(true);
  });

  it.each([
    // The shape a structured-output string takes when a bare `"` closed it early.
    "Klopp downplayed the result, calling it ",
    "Klopp downplayed the result, calling it “a",
    "He called it “a disgrace”",
    "",
  ])("rejects text that stops mid-sentence: %j", (text) => {
    expect(looksComplete(text)).toBe(false);
  });
});

describe("generateWithRetryOnAmbiguousTruncation with typographic quotes", () => {
  it("accepts text ending in a closing typographic quote on the first attempt, with no retry", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: "Klopp downplayed the result, calling it “a bad day.”",
      stopReason: "end_turn",
    });

    const result = await generateWithRetryOnAmbiguousTruncation(generate, "test");

    expect(result.text).toBe("Klopp downplayed the result, calling it “a bad day.”");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("still rejects a quote-cut text after its one retry", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: "Klopp downplayed the result, calling it ",
      stopReason: "end_turn",
    });

    await expect(generateWithRetryOnAmbiguousTruncation(generate, "test")).rejects.toMatchObject({
      name: "GenerationRejectedError",
      reason: "incompleteAfterRetry",
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
