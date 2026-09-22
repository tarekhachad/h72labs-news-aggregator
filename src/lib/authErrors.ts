/**
 * Codes that travel in the `?error=` parameter on /login and /reset-password.
 * Same rule as src/lib/invite.ts's signup codes: the URL carries a code this
 * app defines, never text Supabase produced, so nothing upstream is rendered
 * verbatim on a page.
 */

export const LOGIN_ERROR_MESSAGES = {
  invalid_credentials: "That email and password don't match an account.",
  invalid_email: "Enter a valid email.",
  email_not_confirmed: "Confirm your email address first — check your inbox for the link.",
  link_expired: "That link has expired or was already used. Request a new one below.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  login_failed: "Could not log you in. Try again.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

export function isLoginErrorCode(value: string | undefined): value is LoginErrorCode {
  return value !== undefined && Object.hasOwn(LOGIN_ERROR_MESSAGES, value);
}

export const RESET_ERROR_MESSAGES = {
  weak_password: "Password must be at least 6 characters.",
  same_password: "That is already your password. Pick a different one.",
  reset_failed: "Could not update your password. Request a new link and try again.",
} as const;

export type ResetErrorCode = keyof typeof RESET_ERROR_MESSAGES;

export function isResetErrorCode(value: string | undefined): value is ResetErrorCode {
  return value !== undefined && Object.hasOwn(RESET_ERROR_MESSAGES, value);
}

/** The subset of Supabase's AuthError this app reads. */
type SupabaseAuthErrorish = { code?: string; status?: number; message?: string };

/**
 * `email_not_confirmed` has to survive this mapping intact: it is the one
 * login failure with a user action attached (resend the link), so collapsing
 * it into a generic failure would strand an invitee who never confirmed.
 * It is not an enumeration leak — reaching it requires the correct password.
 */
export function loginErrorCode(error: SupabaseAuthErrorish): LoginErrorCode {
  if (error.status === 429) return "rate_limited";

  switch (error.code) {
    case "invalid_credentials":
      return "invalid_credentials";
    case "email_not_confirmed":
      return "email_not_confirmed";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "rate_limited";
  }

  // Older releases populate only `message`; both forms are mapped so an SDK
  // upgrade cannot silently turn a specific failure into "login_failed".
  const message = error.message?.toLowerCase() ?? "";
  if (message.includes("email not confirmed")) return "email_not_confirmed";
  if (message.includes("invalid login credentials")) return "invalid_credentials";

  return "login_failed";
}
