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
