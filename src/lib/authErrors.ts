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
  reset_unavailable: "Password reset isn't available right now. Try again later.",
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

/** Codes for `/profile?pwError=`, under the same rule as the two lists above. */
export const CHANGE_PASSWORD_ERROR_MESSAGES = {
  current_password_required: "Enter your current password.",
  wrong_current_password: "Your current password is incorrect.",
  weak_password: "Password must be at least 6 characters.",
  password_mismatch: "Passwords don't match.",
  same_password: "That is already your password. Pick a different one.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  reauth_required: "For security, sign out and sign back in, then try again.",
  change_failed: "Could not update your password. Try again.",
} as const;

export type ChangePasswordErrorCode = keyof typeof CHANGE_PASSWORD_ERROR_MESSAGES;

export function isChangePasswordErrorCode(value: string | undefined): value is ChangePasswordErrorCode {
  return value !== undefined && Object.hasOwn(CHANGE_PASSWORD_ERROR_MESSAGES, value);
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

/**
 * Maps an updateUser failure on the in-session password change. Auth answers
 * a wrong current password with `current_password_invalid`, but its message
 * says "Current password required", so the code decides. The message check is
 * a fallback for a response without a code.
 */
export function changePasswordErrorCode(error: SupabaseAuthErrorish): ChangePasswordErrorCode {
  if (error.status === 429) return "rate_limited";

  switch (error.code) {
    case "current_password_invalid":
    case "current_password_required":
      return "wrong_current_password";
    // Auth's nonce-based "Secure password change" setting. It is off today,
    // but if it is ever turned on, a session older than a day would otherwise
    // see a generic failure with no way forward.
    case "reauthentication_needed":
    case "reauthentication_not_valid":
    case "reauth_nonce_missing":
      return "reauth_required";
    case "same_password":
      return "same_password";
    case "weak_password":
      return "weak_password";
    case "over_request_rate_limit":
      return "rate_limited";
  }

  if (error.message?.toLowerCase().includes("current password")) return "wrong_current_password";

  return "change_failed";
}
