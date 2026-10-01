import { afterEach, describe, expect, it, vi } from "vitest";
import { bestEffortLog } from "@/lib/bestEffortLog";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bestEffortLog", () => {
  it.each(["log", "warn", "error"] as const)("passes every argument through to console.%s", (level) => {
    const spy = vi.spyOn(console, level).mockImplementation(() => {});
    const err = new Error("boom");

    bestEffortLog(level, "[x] something happened:", err, 3);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[x] something happened:", err, 3);
  });

  it.each(["log", "warn", "error"] as const)("does not throw when console.%s throws", (level) => {
    const spy = vi.spyOn(console, level).mockImplementation(() => {
      throw new Error("stdout closed");
    });

    expect(() => bestEffortLog(level, "[x] line")).not.toThrow();
    // Reached, so the test exercises the guard rather than skipping it.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the console method itself is missing", () => {
    const original = console.warn;
    (console as { warn: unknown }).warn = undefined;
    try {
      expect(() => bestEffortLog("warn", "[x] line")).not.toThrow();
    } finally {
      console.warn = original;
    }
  });

  it("returns undefined, so a caller cannot come to depend on its result", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(bestEffortLog("log", "[x] line")).toBeUndefined();
  });
});
