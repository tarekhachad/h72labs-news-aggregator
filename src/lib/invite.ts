/**
 * Invite links: minting (scripts/invite.mts) and the signup path
 * (src/app/auth/actions.ts, src/app/signup/page.tsx).
 *
 * The enforcement is NOT here. It is `public.hook_require_invite` in
 * supabase/schema.sql, a before-user-created auth hook, because Supabase's
 * signup endpoint is callable directly with the publishable key and never
 * passes through this app. Everything in this file is convenience around that
 * boundary: generating tokens, and turning the hook's rejections into text.
 *
 * Imported by a Node script as well as by Next, so no "@/" path aliases.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const INVITE_TTL_DAYS = 7;

const TOKEN_BYTES = 32;

/** 32 bytes as unpadded base64url is always exactly 43 characters. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Must stay byte-identical to the hook's
 * `encode(sha256(convert_to(token, 'UTF8')), 'hex')` — if the two disagree,
 * every invite is rejected as forged. The test pins both to a known vector.
 */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function buildInviteLink(baseUrl: string, token: string): string {
  const url = new URL("/signup", baseUrl);
  url.searchParams.set("invite", token);
  return url.toString();
}

export function inviteExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

const InviteArgs = z.object({
  label: z.string().trim().min(1, "A label is required, e.g. the invitee's name"),
  // Lowercased because the hook compares against the email Supabase Auth
  // passes it, which Auth has already lowercased.
  email: z.string().trim().email("A valid email is required").transform((e) => e.toLowerCase()),
});

export type InviteArgs = z.infer<typeof InviteArgs>;

export function parseInviteArgs(
  argv: readonly string[]
): { ok: true; args: InviteArgs } | { ok: false; message: string } {
  if (argv.length !== 2) {
    return { ok: false, message: 'Usage: npm run invite -- "<label>" <email>' };
  }
  const parsed = InviteArgs.safeParse({ label: argv[0], email: argv[1] });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid arguments" };
  }
  return { ok: true, args: parsed.data };
}

/**
 * Codes that travel in the `/signup?error=` parameter. The URL carries a code,
 * never free text, so nothing Supabase says reaches the page verbatim.
 * The first three are the exact messages the hook returns.
 */
export const SIGNUP_ERROR_MESSAGES = {
  invite_required: "Sign up is invite-only. Use the invite link you were sent.",
  invite_invalid: "This invite link is invalid, expired, or already used.",
  invite_email_mismatch: "This invite was sent to a different email address. Use the address the invite was for.",
  invalid_email: "Enter a valid email.",
  weak_password: "Password must be at least 6 characters.",
  signup_failed: "Could not create your account.",
} as const;

export type SignupErrorCode = keyof typeof SIGNUP_ERROR_MESSAGES;

const HOOK_CODES: readonly SignupErrorCode[] = [
  "invite_required",
  "invite_invalid",
  "invite_email_mismatch",
];

/**
 * Maps a Supabase signUp error message to a code. Anything that is not one of
 * the hook's own codes collapses to `signup_failed`, including "User already
 * registered", which would otherwise tell a link-holder whether an address
 * has an account.
 */
export function signupErrorCode(supabaseMessage: string): SignupErrorCode {
  return (HOOK_CODES as readonly string[]).includes(supabaseMessage)
    ? (supabaseMessage as SignupErrorCode)
    : "signup_failed";
}

export function isSignupErrorCode(value: string | undefined): value is SignupErrorCode {
  return value !== undefined && Object.hasOwn(SIGNUP_ERROR_MESSAGES, value);
}
