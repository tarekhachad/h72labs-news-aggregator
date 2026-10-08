/**
 * Carries the address a signup link just confirmed from /auth/confirm to the
 * login form, so the reader only types their password. A cookie rather than
 * a query parameter keeps the address out of the URL, and so out of browser
 * history, server logs and Referer headers.
 *
 * Path-scoped to /login, so the browser sends it to no other page. A server
 * component can't delete a cookie in this Next version, so the login page
 * only reads it: the sign-in action deletes it once sign-in succeeds, and
 * max-age expires it if the reader never signs in.
 */

import { wellFormedEmail } from "@/lib/invite";

export const CONFIRMED_EMAIL_COOKIE = "pna_confirmed_email";

export const CONFIRMED_EMAIL_PATH = "/login";

export const CONFIRMED_EMAIL_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: CONFIRMED_EMAIL_PATH,
  maxAge: 10 * 60,
} as const;

/** The address to pre-fill, or null when the cookie is missing or isn't one. */
export function confirmedEmailFromCookie(value: string | undefined): string | null {
  return wellFormedEmail(value);
}
