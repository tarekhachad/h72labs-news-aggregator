import { describe, expect, it } from "vitest";
import { TOPICS } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { ProfileInput } from "@/lib/profile";
import { PROFILE_ERROR_MESSAGES, isProfileErrorCode, profileErrorCode } from "@/lib/profileErrors";

// Every way ProfileInput refuses maps to one code, through the issue's own
// params or the field it failed on, never through its message text.

const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);

function codeFor(input: { topics: unknown[]; preferredSources?: unknown[]; countries?: unknown[] }) {
  const parsed = ProfileInput.safeParse({ preferredSources: [], ...input });
  if (parsed.success) throw new Error("expected a refusal");
  return profileErrorCode(parsed.error.issues);
}

describe("profileErrorCode over ProfileInput's refusals", () => {
  it.each([
    ["no topics", { topics: [] }, "too_few"],
    ["2 topics", { topics: plain.slice(0, 2) }, "too_few"],
    ["1 topic and 1 country", { topics: plain.slice(0, 1), countries: ["Morocco"] }, "too_few"],
    ["11 topics", { topics: plain.slice(0, 11) }, "too_many"],
    ["8 topics and 3 countries", { topics: plain.slice(0, 8), countries: ["Morocco", "Kenya", "Ghana"] }, "too_many"],
    ["a topic not in the list", { topics: [...plain.slice(0, 3), "Atlantis News"] }, "unknown_topic"],
    ["a country not in the list", { topics: plain.slice(0, 3), countries: ["Atlantis"] }, "unknown_country"],
    ["an empty country", { topics: plain.slice(0, 3), countries: [""] }, "unknown_country"],
    ["a country that isn't text", { topics: plain.slice(0, 3), countries: [42] }, "unknown_country"],
    ["a source not in the list", { topics: plain.slice(0, 3), preferredSources: ["Atlantis Times"] }, "unknown_source"],
    ["topics that aren't a list", { topics: "Football" as unknown as unknown[] }, "unknown_topic"],
  ] as const)("%s → %s", (_name, input, code) => {
    expect(codeFor(input as never)).toBe(code);
  });

  it("does not depend on the issue's message", () => {
    expect(profileErrorCode([{ code: "custom", path: [], params: { code: "too_few" }, message: "anything" } as never])).toBe(
      "too_few"
    );
  });

  it("falls back to invalid for no issue, an uncoded custom issue, or an unknown field", () => {
    expect(profileErrorCode([])).toBe("invalid");
    expect(profileErrorCode([{ code: "custom", path: [] }])).toBe("invalid");
    expect(profileErrorCode([{ code: "custom", path: [], params: { code: "<script>" } }])).toBe("invalid");
    expect(profileErrorCode([{ code: "invalid_type", path: ["somethingElse"] }])).toBe("invalid");
  });
});

describe("PROFILE_ERROR_MESSAGES", () => {
  it("has one plain message per code, with no submitted text to fill in", () => {
    for (const [code, message] of Object.entries(PROFILE_ERROR_MESSAGES)) {
      expect(isProfileErrorCode(code)).toBe(true);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/[{}$<>]/);
    }
  });

  it("accepts only its own codes", () => {
    expect(isProfileErrorCode("too_few")).toBe(true);
    expect(isProfileErrorCode("toString")).toBe(false);
    expect(isProfileErrorCode("Pick at least 3 topics")).toBe(false);
    expect(isProfileErrorCode(undefined)).toBe(false);
  });
});
