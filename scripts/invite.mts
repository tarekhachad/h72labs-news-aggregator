/**
 * Mints one invite link: `npm run invite -- "<label>" <email>`.
 *
 * I/O only — token generation, hashing, argument parsing and the link shape
 * live in `src/lib/invite.ts`, which is pure and tested.
 *
 * Needs the Supabase SECRET key, because `public.invites` accepts no writes
 * from any session. That key bypasses RLS, so it lives in `.env.admin`, which
 * only this script loads (via `node --env-file`). It is deliberately not in
 * `.env.local`, which Next loads into the dev server, and it never goes into
 * Vercel: the deployed app holds no key that bypasses RLS.
 */

import { createClient } from "@supabase/supabase-js";
import {
  buildInviteLink,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  parseInviteArgs,
} from "../src/lib/invite.ts";

const DEFAULT_BASE_URL = "https://news.h72labs.com";

async function main(): Promise<void> {
  const parsed = parseInviteArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exitCode = 1;
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must both be set in .env.admin.");
    process.exitCode = 1;
    return;
  }
  const baseUrl = process.env.INVITE_BASE_URL || DEFAULT_BASE_URL;

  const token = generateInviteToken();
  const expiresAt = inviteExpiry(new Date());

  const supabase = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.from("invites").insert({
    token_hash: hashInviteToken(token),
    email: parsed.args.email,
    label: parsed.args.label,
    expires_at: expiresAt.toISOString(),
  });
  if (error) {
    // The PostgREST error names the failing constraint or permission; it
    // never contains the key.
    console.error(`Could not create the invite: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Invite for ${parsed.args.label} <${parsed.args.email}>`);
  console.log(`Expires ${expiresAt.toISOString()}`);
  console.log("");
  console.log(buildInviteLink(baseUrl, token));
}

await main();
