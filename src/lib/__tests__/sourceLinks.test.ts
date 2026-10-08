import { describe, it, expect, vi, afterEach } from "vitest";
import { signSourceLink, sourceLinkSecret, verifySourceLink } from "@/lib/sourceLinks";

const SECRET = "test-source-link-secret-0123456789abcdef0123";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("source link signatures", () => {
  it("verifies a signature made for the same link with the same secret", () => {
    const url = "https://www.theguardian.com/world/2026/oct/08/story";
    expect(verifySourceLink(url, signSourceLink(url, SECRET), SECRET)).toBe(true);
  });

  it("refuses a different link, a different secret, a missing or malformed signature", () => {
    const url = "https://example.com/a";
    const sig = signSourceLink(url, SECRET);
    expect(verifySourceLink("https://example.com/b", sig, SECRET)).toBe(false);
    expect(verifySourceLink(url, sig, `${SECRET}-other`)).toBe(false);
    expect(verifySourceLink(url, undefined, SECRET)).toBe(false);
    expect(verifySourceLink(url, "", SECRET)).toBe(false);
    expect(verifySourceLink(url, 42, SECRET)).toBe(false);
    expect(verifySourceLink(url, sig.slice(0, -1), SECRET)).toBe(false);
  });

  it("signs the exact URL: a trailing character changes the signature", () => {
    expect(signSourceLink("https://example.com/a", SECRET)).not.toBe(signSourceLink("https://example.com/a/", SECRET));
  });

  it("refuses a missing or short secret", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SOURCE_LINK_SECRET", "");
    expect(sourceLinkSecret()).toBeNull();
    vi.stubEnv("SOURCE_LINK_SECRET", "too-short");
    expect(sourceLinkSecret()).toBeNull();
    vi.stubEnv("SOURCE_LINK_SECRET", SECRET);
    expect(sourceLinkSecret()).toBe(SECRET);
  });
});
