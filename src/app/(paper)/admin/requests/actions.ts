"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { bestEffortLog } from "@/lib/bestEffortLog";
import { sendEmail } from "@/lib/email";
import { buildInviteLink, generateInviteToken, hashInviteToken, inviteBaseUrl } from "@/lib/invite";
import { approvalEmail, declineEmail } from "@/lib/inviteEmails";
import { adminErrorCode, type AdminResultCode } from "@/lib/inviteRequest";

export type AdminRowState = { code: AdminResultCode | null; link?: string };

// Loose on purpose: by the time this is checked the decision has committed,
// so a stricter check could only turn a done approval into a reported failure.
const Decided = z.array(z.object({ email: z.string().min(1), name: z.string() })).length(1);

function requestId(formData: FormData): string | null {
  const id = z.string().uuid().safeParse(formData.get("id"));
  return id.success ? id.data : null;
}

/**
 * Who may approve is decided by approve_invite_request (app_admins), not
 * here: this action runs for anyone who posts to it, and a reader who is not
 * an admin gets `failed` with nothing written.
 *
 * The raw token exists only in this function and the email. The database
 * gets its hash, the same as `npm run invite`.
 */
export async function approveRequest(_previous: AdminRowState, formData: FormData): Promise<AdminRowState> {
  const id = requestId(formData);
  if (!id) return { code: "failed" };

  const token = generateInviteToken();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("approve_invite_request", {
    p_id: id,
    p_token_hash: hashInviteToken(token),
  });
  if (error) return { code: adminErrorCode(error.message) };
  // The request moved out of pending: refresh the list and the badge.
  revalidatePath("/", "layout");
  const decided = Decided.safeParse(data);
  if (!decided.success) {
    bestEffortLog("error", "[admin-requests] approve returned an unexpected shape");
    return { code: "unknown" };
  }

  const { email, name } = decided.data[0];
  const link = buildInviteLink(inviteBaseUrl(), token, email);
  const sent = await sendEmail(approvalEmail(email, name, link));
  if (!sent.ok) {
    bestEffortLog("warn", "[admin-requests] invite email not sent", sent.reason);
    // Shown to the admin only, once: it is the only copy of the token.
    return { code: "approved_unsent", link };
  }
  return { code: "approved" };
}

export async function declineRequest(_previous: AdminRowState, formData: FormData): Promise<AdminRowState> {
  const id = requestId(formData);
  if (!id) return { code: "failed" };
  const notify = formData.get("notify") === "on";

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decline_invite_request", { p_id: id });
  if (error) return { code: adminErrorCode(error.message) };
  // The request moved out of pending: refresh the list and the badge.
  revalidatePath("/", "layout");
  const decided = Decided.safeParse(data);
  if (!decided.success) {
    bestEffortLog("error", "[admin-requests] decline returned an unexpected shape");
    return { code: "unknown" };
  }

  if (!notify) return { code: "declined" };
  const sent = await sendEmail(declineEmail(decided.data[0].email));
  if (!sent.ok) bestEffortLog("warn", "[admin-requests] decline email not sent", sent.reason);
  return { code: sent.ok ? "declined_emailed" : "declined_unsent" };
}
