/**
 * Sends one email through Resend's HTTP API. Supabase Auth sends its own
 * emails through Resend's SMTP, configured in the dashboard; this is the
 * app's path, used only by invite requests.
 *
 * RESEND_API_KEY is server-only: no NEXT_PUBLIC_ prefix, read at call time,
 * never passed to a client component. A sending-only key scoped to the
 * h72labs.com domain is enough.
 */

import { PRODUCT_NAME } from "@/config/brand";

// The display name stays plain ASCII: a non-ASCII character there needs
// RFC 2047 encoding, which not every sender path applies.
export const EMAIL_FROM = `${PRODUCT_NAME} by H72 Labs <no-reply@h72labs.com>`;

const RESEND_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 8000;

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
};

export type SendResult = { ok: true } | { ok: false; reason: "not_configured" | "rejected" | "network" };

/**
 * Never throws: every caller sends after its database write has committed,
 * so a failed send is reported, not raised, and the caller decides what the
 * reader sees.
 */
export async function sendEmail(
  email: OutgoingEmail,
  fetchImpl: typeof fetch = fetch,
  apiKey: string | undefined = process.env.RESEND_API_KEY
): Promise<SendResult> {
  if (!apiKey) return { ok: false, reason: "not_configured" };
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, reason: "rejected" };
  } catch {
    return { ok: false, reason: "network" };
  }
}
