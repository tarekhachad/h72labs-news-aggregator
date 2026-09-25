/**
 * Proof that the current browser opened a password-recovery link.
 *
 * /reset-password sets a new password without the old one and then signs the
 * account out everywhere else, so it must be reachable only from a real reset
 * link. Supabase can't provide that proof: Auth records every emailed link
 * with the same `otp` method, so a session from a signup confirmation looks
 * identical to one from a reset. This marker is set by /auth/confirm only
 * after a successful `type=recovery` verification, and it is signed with a
 * server-only secret so no client can mint one.
 *
 * It is bound to one session, not just one account: `markerSubject` joins the
 * user id and the session id, so the marker stops working the moment that
 * session ends, even if the cookie is left behind or copied.
 *
 * Format: `<subject>.<issuedAtSeconds>.<base64url HMAC-SHA256 of the first two>`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const RECOVERY_COOKIE = "pna_recovery";

/** Matches the reset link's own lifetime. */
export const RECOVERY_WINDOW_SECONDS = 60 * 60;

/** Tolerance for clock drift between serverless instances. */
const FUTURE_SKEW_SECONDS = 60;

/** 32 bytes of entropy as base64 is 44 characters; anything shorter is refused. */
const MIN_SECRET_LENGTH = 32;

export const RECOVERY_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: RECOVERY_WINDOW_SECONDS,
} as const;

/**
 * The signing secret, or null when it is missing or too short. Callers treat
 * null as "no proof possible": the reset page stays closed rather than
 * accepting an unsigned or weakly signed marker.
 */
export function recoverySecret(): string | null {
  const secret = process.env.RECOVERY_MARKER_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
}

/**
 * The session a marker is bound to. Both ids are UUIDs, so the result never
 * contains the `.` the marker format splits on.
 */
export function markerSubject(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

/** The subject for a verified claims object, or null when either id is missing. */
export function subjectFromClaims(claims: unknown): string | null {
  const c = claims as { sub?: unknown; session_id?: unknown } | null | undefined;
  if (typeof c?.sub !== "string" || typeof c?.session_id !== "string") return null;
  if (c.sub === "" || c.session_id === "") return null;
  return markerSubject(c.sub, c.session_id);
}

/**
 * The session id inside an access token Auth has just issued, read without
 * verifying the signature. That is only safe because the token came straight
 * back from Auth in this same request; never call it on a token a client sent.
 */
export function sessionIdOfFreshToken(accessToken: string | undefined): string | null {
  const payload = accessToken?.split(".")[1];
  if (!payload) return null;
  try {
    const sessionId = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.session_id;
    return typeof sessionId === "string" ? sessionId : null;
  } catch {
    return null;
  }
}

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function signRecoveryMarker(subject: string, nowSeconds: number, secret: string): string {
  const payload = `${subject}.${nowSeconds}`;
  return `${payload}.${mac(payload, secret)}`;
}

export function verifyRecoveryMarker(
  value: string | undefined,
  subject: string | null,
  secret: string | null,
  // Defaulted here rather than at the call sites: one of them is a server
  // component, where the lint rule forbids calling Date.now() during render.
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!value || !secret || !subject) return false;

  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [markerSubjectValue, issuedRaw, signature] = parts;

  // The marker proves one session's recovery. A marker from another account,
  // or from an earlier session of this one, must not open the reset form.
  if (markerSubjectValue !== subject) return false;
  if (!/^\d+$/.test(issuedRaw)) return false;

  const expected = Buffer.from(mac(`${markerSubjectValue}.${issuedRaw}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;

  const age = nowSeconds - Number(issuedRaw);
  return age <= RECOVERY_WINDOW_SECONDS && age >= -FUTURE_SKEW_SECONDS;
}
