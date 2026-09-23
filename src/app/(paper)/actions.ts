"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

// Only a shape check. Whether the name is a real zone is set_time_zone's
// call, against Postgres's own tzdata — the value every reader then uses.
const TimeZoneInput = z.string().min(1).max(64);

/**
 * Stores the reader's device timezone. Called by TimeZoneSync, never by a
 * form, so it returns a result instead of redirecting.
 */
export async function syncTimeZone(timeZone: unknown): Promise<{ ok: boolean }> {
  const parsed = TimeZoneInput.safeParse(timeZone);
  if (!parsed.success) return { ok: false };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  const { error } = await supabase.rpc("set_time_zone", { p_time_zone: parsed.data });
  if (error) {
    console.error("[syncTimeZone] set_time_zone refused:", error.message);
    return { ok: false };
  }
  return { ok: true };
}
