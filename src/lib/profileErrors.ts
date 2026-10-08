import { MAX_READING_UNITS, MIN_READING_UNITS } from "@/lib/readingUnits";

/**
 * Why a preference save was refused, as a code the onboarding and profile
 * actions return to the form. Same rule as src/lib/authErrors.ts: the reader
 * sees one fixed message per code, never text built from what was submitted.
 */
export const PROFILE_ERROR_MESSAGES = {
  too_few: `Pick at least ${MIN_READING_UNITS} topics. Each country you pick counts as one.`,
  too_many: `Pick at most ${MAX_READING_UNITS} topics. Each country you pick counts as one.`,
  unknown_topic: "One of those topics isn't on the list. Reload the page and pick again.",
  unknown_country: "One of those countries isn't on the list. Reload the page and pick again.",
  unknown_source: "One of those sources isn't on the list. Reload the page and pick again.",
  invalid: "Your picks couldn't be read. Reload the page and try again.",
  save_failed: "Couldn't save your preferences — try again.",
} as const;

export type ProfileErrorCode = keyof typeof PROFILE_ERROR_MESSAGES;

export function isProfileErrorCode(value: unknown): value is ProfileErrorCode {
  return typeof value === "string" && Object.hasOwn(PROFILE_ERROR_MESSAGES, value);
}

/** What a preference action returns when it refuses a save; a successful save redirects instead. */
export type PreferencesState = { error: ProfileErrorCode | null };

/** The fields of a zod issue this mapping reads. */
type Issueish = { code: string; path: readonly PropertyKey[]; params?: Record<string, unknown> };

/**
 * The code for a refused ProfileInput parse. ProfileInput's own checks carry
 * their code in `params.code`; zod's built-in issues (a value outside the
 * topic or source list, a non-string field) are coded by the field they
 * failed on.
 */
export function profileErrorCode(issues: readonly Issueish[]): ProfileErrorCode {
  const issue = issues[0];
  if (issue === undefined) return "invalid";
  if (issue.code === "custom") {
    const code = issue.params?.code;
    return isProfileErrorCode(code) ? code : "invalid";
  }
  switch (issue.path[0]) {
    case "topics":
      return "unknown_topic";
    case "countries":
      return "unknown_country";
    case "preferredSources":
      return "unknown_source";
    default:
      return "invalid";
  }
}
