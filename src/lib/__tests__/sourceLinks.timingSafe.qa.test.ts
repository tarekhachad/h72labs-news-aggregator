import { describe, it, expect, vi } from "vitest";

// QA (v2.6.3): a plain === compare verifies exactly the same signatures, so
// only a spy can tell the constant-time comparison is the one doing the work.
const { spy } = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  spy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, default: actual, timingSafeEqual: spy };
});

import { signSourceLink, verifySourceLink } from "@/lib/sourceLinks";

const SECRET = "qa-source-link-secret-0123456789abcdef01234567";

describe("verifySourceLink compares in constant time (QA)", () => {
  it("decides an equal-length signature through timingSafeEqual", () => {
    const url = "https://example.com/a";
    const sig = signSourceLink(url, SECRET);
    spy.mockClear();
    expect(verifySourceLink(url, sig, SECRET)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    expect(verifySourceLink(url, `${sig.slice(0, -1)}${sig.at(-1) === "A" ? "B" : "A"}`, SECRET)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
