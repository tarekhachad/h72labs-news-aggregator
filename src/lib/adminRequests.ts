/**
 * Reads for /admin/requests and the sidebar badge. Both go through security
 * definer functions that check app_admins (supabase/schema.sql), so a reader
 * who is not an admin gets null here, never someone else's request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * The pending count for an admin, null for everyone else. Never rejects: it
 * feeds a badge on every newspaper page, and a failed lookup must cost the
 * badge, not the page.
 */
export async function loadPendingRequestCount(supabase: SupabaseClient): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc("pending_invite_request_count");
    if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) return null;
    return data;
  } catch {
    return null;
  }
}

const RequestRow = z.object({
  id: z.string().uuid(),
  created_at: z.string(),
  name: z.string(),
  email: z.string(),
  referral: z.string(),
  interests: z.string(),
  note: z.string(),
  link: z.string().nullable(),
  had_account: z.boolean(),
  has_account: z.boolean(),
  earlier_requests: z.number().int(),
  status: z.enum(["pending", "approved", "declined"]),
  decided_at: z.string().nullable(),
  invite_expires_at: z.string().nullable(),
  invite_consumed_at: z.string().nullable(),
});

export type InviteRequestRow = z.infer<typeof RequestRow>;

export type RequestList =
  | { kind: "ok"; rows: InviteRequestRow[] }
  | { kind: "not_admin" }
  | { kind: "failed" };

export async function loadInviteRequests(supabase: SupabaseClient): Promise<RequestList> {
  const { data, error } = await supabase.rpc("list_invite_requests");
  if (error) return error.message === "not_admin" ? { kind: "not_admin" } : { kind: "failed" };
  const parsed = z.array(RequestRow).safeParse(data);
  return parsed.success ? { kind: "ok", rows: parsed.data } : { kind: "failed" };
}

/** One line on what happened to an approved request's invite. */
export function inviteState(row: InviteRequestRow, now: Date): string | null {
  if (row.status !== "approved") return null;
  if (row.invite_consumed_at) return "Signed up";
  if (!row.invite_expires_at) return "Invite removed";
  return new Date(row.invite_expires_at) <= now ? "Invite expired unused" : "Invite not used yet";
}
