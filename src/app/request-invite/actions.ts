"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { bestEffortLog } from "@/lib/bestEffortLog";
import { sendEmail } from "@/lib/email";
import { inviteBaseUrl } from "@/lib/invite";
import { newRequestEmail } from "@/lib/inviteEmails";
import {
  InviteRequestFields,
  clientIp,
  inviteRequestEnv,
  isSubmitOutcome,
  outcomeToState,
  readRequestForm,
  sourceHash,
  verifyTurnstile,
  type InviteRequestField,
  type RequestErrorCode,
  type RequestFormState,
} from "@/lib/inviteRequest";

function refused(
  code: RequestErrorCode,
  values: Record<InviteRequestField, string>,
  fieldErrors: Partial<Record<InviteRequestField, string>> = {}
): RequestFormState {
  return { status: "error", code, fieldErrors, values };
}

/**
 * The order matters: fields first (free), then Turnstile (one HTTP call), and
 * only then the database. The function behind the RPC refuses any call
 * without INVITE_REQUEST_SECRET, so this action is the only way in, and the
 * bot check cannot be skipped by calling the database directly.
 */
export async function requestInvite(_previous: RequestFormState, formData: FormData): Promise<RequestFormState> {
  const values = readRequestForm(formData);
  const parsed = InviteRequestFields.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<InviteRequestField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as InviteRequestField;
      fieldErrors[field] ??= issue.message;
    }
    return refused("invalid", values, fieldErrors);
  }

  const env = inviteRequestEnv();
  if (!env) {
    bestEffortLog("error", "[invite-request] INVITE_REQUEST_SECRET or TURNSTILE_SECRET_KEY is not set");
    return refused("unavailable", values);
  }

  const ip = clientIp(await headers());
  if (!(await verifyTurnstile(formData.get("cf-turnstile-response"), env.turnstileSecret, ip))) {
    return refused("bot_check", values);
  }

  const request = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_invite_request", {
    p_server_key: env.serverKey,
    p_source_hash: sourceHash(ip, env.serverKey),
    p_name: request.name,
    p_email: request.email,
    p_referral: request.referral,
    p_interests: request.interests,
    p_note: request.note,
    p_link: request.link,
  });
  if (error || !isSubmitOutcome(data)) {
    bestEffortLog("error", "[invite-request] submit failed", error?.code ?? "unexpected result");
    return refused("unavailable", values);
  }

  const notifyTo = process.env.ADMIN_NOTIFY_EMAIL;
  if (data === "created" && notifyTo) {
    // After the response, so a new request and a repeat one answer in the
    // same time: waiting on the send would tell a visitor which addresses
    // already have a request pending. A lost notice only means Tarek sees
    // the request on the badge instead of in his inbox.
    const notice = newRequestEmail(notifyTo, request, new URL("/admin/requests", inviteBaseUrl()).toString());
    after(async () => {
      const sent = await sendEmail(notice);
      if (!sent.ok) bestEffortLog("warn", "[invite-request] notice not sent", sent.reason);
    });
  }

  return outcomeToState(data, values);
}
