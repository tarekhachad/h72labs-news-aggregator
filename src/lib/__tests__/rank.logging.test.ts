import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

const CANDIDATES = [
  { topic: "Tech/AI" as const, severity: 3, text: "Story 0" },
  { topic: "Tech/AI" as const, severity: 2, text: "Story 1" },
];

beforeEach(() => {
  mockParse.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rankFrontPage when its failure log throws", () => {
  function breakConsoleError() {
    return vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr closed");
    });
  }

  it("still fails open with null when the call itself fails", async () => {
    mockParse.mockRejectedValue(new Error("API down"));
    const errorSpy = breakConsoleError();
    const { rankFrontPage } = await import("@/lib/rank");

    await expect(rankFrontPage(CANDIDATES)).resolves.toBeNull();
    // The throwing line was actually reached, so the test exercises the guard.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("still fails open with null when a billed response has no parsed output", async () => {
    mockParse.mockResolvedValue({ parsed_output: null, stop_reason: "max_tokens" });
    const errorSpy = breakConsoleError();
    const { rankFrontPage } = await import("@/lib/rank");

    await expect(rankFrontPage(CANDIDATES)).resolves.toBeNull();
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the paid ranks untouched when a broken console is never reached", async () => {
    mockParse.mockResolvedValue({ parsed_output: { picks: [{ index: 1, rank: 1 }] } });
    breakConsoleError();
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout closed");
    });
    const { rankFrontPage } = await import("@/lib/rank");

    await expect(rankFrontPage(CANDIDATES)).resolves.toEqual([null, 1]);
  });
});
