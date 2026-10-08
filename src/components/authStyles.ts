/** Shared look for the signed-out pages: login, signup, and the email flows. */

export const INPUT_CLASS = "rounded-xl border px-4 py-3 text-sm";

export const INPUT_STYLE = {
  borderColor: "var(--color-border)",
  background: "var(--color-card)",
  color: "var(--color-card-foreground)",
} as const;

export const SUBMIT_CLASS =
  "cursor-pointer self-center rounded-full px-8 py-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

export const SUBMIT_STYLE = {
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
} as const;

/** The show/hide button that sits inside a password field's right edge. */
export const PASSWORD_TOGGLE_CLASS =
  "absolute inset-y-0 right-0 cursor-pointer px-4 text-xs font-medium underline-offset-2 hover:underline focus-visible:underline";

export const PASSWORD_TOGGLE_STYLE = {
  color: "var(--color-muted-foreground)",
} as const;

/** A rule shown under a field before it can be broken, e.g. the password minimum. */
export const FIELD_HINT_CLASS = "text-xs";

export const FIELD_HINT_STYLE = {
  color: "var(--color-muted-foreground)",
} as const;

/**
 * Must match what the server refuses: `Credentials` and `resetPassword` in
 * src/app/auth/actions.ts and `changePassword` in the profile's actions all
 * reject fewer than 6 characters, as does Supabase Auth's default minimum.
 * A test pins the actions to this number.
 */
export const MIN_PASSWORD_LENGTH = 6;

export const NEW_PASSWORD_RULE = `At least ${MIN_PASSWORD_LENGTH} characters`;
