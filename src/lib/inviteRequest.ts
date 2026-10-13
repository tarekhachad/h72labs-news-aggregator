/**
 * Invite requests: a visitor asks on /request-invite, Tarek decides on
 * /admin/requests (src/app/request-invite, src/app/(paper)/admin).
 *
 * The gates are NOT here. They are the security definer functions in
 * supabase/schema.sql ("V2.7 migration: invite requests"): submitting needs
 * the server key, and listing, approving and declining need an account in
 * app_admins. This file is the server's side of that: reading the form,
 * the Turnstile check, and the hashes it sends.
 */

import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

/** Matches the length checks on public.invite_requests. */
export const REQUEST_LIMITS = {
  name: 100,
  email: 254,
  referral: 300,
  interests: 500,
  note: 1000,
  link: 300,
} as const;

// Postgres text cannot hold a NUL character, so it is refused here as a field
// error instead of failing the insert as "requests aren't open".
const noNul = (s: string) => !s.includes("\u0000");
const NUL_MESSAGE = "Remove the unusual character from this field.";

const required = (max: number, message: string) =>
  z.string().trim().min(1, message).max(max, `Keep this under ${max} characters.`).refine(noNul, NUL_MESSAGE);

export const InviteRequestFields = z.object({
  // One line: the name goes into an email subject.
  name: required(REQUEST_LIMITS.name, "Enter your name.").transform((s) => s.replace(/\s+/g, " ")),
  email: z
    .string()
    .trim()
    .max(REQUEST_LIMITS.email, "Enter a valid email.")
    .email("Enter a valid email.")
    .transform((e) => e.toLowerCase()),
  referral: required(REQUEST_LIMITS.referral, "Tell us how you heard about it."),
  interests: required(REQUEST_LIMITS.interests, "Tell us what you'd like to read."),
  note: required(REQUEST_LIMITS.note, "Add a short note."),
  // Optional, but when present it must be a web address: the admin page
  // renders it as a link.
  link: z
    .string()
    .trim()
    .max(REQUEST_LIMITS.link, `Keep this under ${REQUEST_LIMITS.link} characters.`)
    .refine(noNul, NUL_MESSAGE)
    .refine((v) => v === "" || isWebUrl(v), "Enter a full web address, starting with https://."),
});

export type InviteRequestFields = z.infer<typeof InviteRequestFields>;
export type InviteRequestField = keyof InviteRequestFields;

export const FIELD_NAMES = Object.keys(InviteRequestFields.shape) as InviteRequestField[];

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Every field as a string, for echoing back into the form after a refusal. */
export function readRequestForm(formData: FormData): Record<InviteRequestField, string> {
  const values = {} as Record<InviteRequestField, string>;
  for (const name of FIELD_NAMES) {
    const raw = formData.get(name);
    values[name] = typeof raw === "string" ? raw : "";
  }
  return values;
}

/** What submit_invite_request returns. */
export type SubmitOutcome = "created" | "duplicate" | "closed" | "rate_limited";

export function isSubmitOutcome(value: unknown): value is SubmitOutcome {
  return value === "created" || value === "duplicate" || value === "closed" || value === "rate_limited";
}

/**
 * Codes the form can show. A duplicate is reported as success on purpose:
 * a different answer would tell anyone with the form whether an address
 * has a request waiting.
 */
export const REQUEST_ERROR_MESSAGES = {
  invalid: "Check the highlighted fields.",
  bot_check: "We couldn't confirm you're not a bot. Try again.",
  closed: "We're not taking more requests today. Try again tomorrow.",
  unavailable: "Requests aren't open right now. Try again later.",
} as const;

export type RequestErrorCode = keyof typeof REQUEST_ERROR_MESSAGES;

export type RequestFormState =
  | { status: "idle" }
  | { status: "sent" }
  | {
      status: "error";
      code: RequestErrorCode;
      fieldErrors: Partial<Record<InviteRequestField, string>>;
      values: Record<InviteRequestField, string>;
    };

export function outcomeToState(
  outcome: SubmitOutcome,
  values: Record<InviteRequestField, string>
): RequestFormState {
  if (outcome === "created" || outcome === "duplicate") return { status: "sent" };
  return { status: "error", code: "closed", fieldErrors: {}, values };
}

/** Same rule as the database: sha256 hex of the UTF-8 key. */
export function hashServerKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Keyed, so the stored value cannot be reversed to an IP by hashing every
 * address (IPv4 has only 2^32 of them). Null when the platform gave no IP:
 * that request then counts only against the global cap.
 */
export function sourceHash(ip: string | null, secret: string): string | null {
  if (!ip) return null;
  return createHmac("sha256", secret).update(`invite-request-source:${ip}`, "utf8").digest("hex");
}

/**
 * The visitor's IP as Vercel reports it. x-real-ip is set by Vercel's edge
 * and cannot be supplied by the client; x-forwarded-for's first entry is the
 * fallback for other hosts.
 */
export function clientIp(headers: Headers): string | null {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

/** 32 characters at least, so a short placeholder can't be the live key. */
export const MIN_SERVER_KEY_LENGTH = 32;

export type InviteRequestEnv = {
  serverKey: string;
  turnstileSecret: string;
};

export function inviteRequestEnv(): InviteRequestEnv | null {
  const serverKey = process.env.INVITE_REQUEST_SECRET;
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (!serverKey || serverKey.length < MIN_SERVER_KEY_LENGTH || !turnstileSecret) return null;
  return { serverKey, turnstileSecret };
}

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5000;

/**
 * Fails closed: a network error, a timeout, or anything but an explicit
 * success counts as a failed check. Cloudflare's tokens are at most 2048
 * characters, so a longer one is refused without a call.
 */
export async function verifyTurnstile(
  token: unknown,
  secret: string,
  ip: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (typeof token !== "string" || token === "" || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data: unknown = await res.json();
    return typeof data === "object" && data !== null && (data as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}

/** Codes the admin page can show after an approve or decline. */
export const ADMIN_RESULT_MESSAGES = {
  approved: "Approved. The invite is on its way.",
  approved_unsent: "Approved, but the email didn't send. Send this link yourself:",
  declined: "Declined.",
  declined_emailed: "Declined, and the email is on its way.",
  declined_unsent: "Declined, but the email didn't send.",
  not_pending: "That request was already decided.",
  has_account: "That email already has an account. Decline the request instead.",
  failed: "Something went wrong. Nothing was changed.",
  unknown: "Something went wrong. Reload the page to see where the request stands.",
} as const;

export type AdminResultCode = keyof typeof ADMIN_RESULT_MESSAGES;

/** Maps a database error from approve or decline to a result code. */
export function adminErrorCode(message: string | undefined): AdminResultCode {
  if (message === "not_pending" || message === "has_account") return message;
  return "failed";
}
