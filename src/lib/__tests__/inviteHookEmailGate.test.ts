import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The invite link now carries the invitee's email, and the signup page locks
// the field to it. That is safe only because the hook, not the page, matches
// the email: it compares the address Auth received against the one stored
// with the token, and spends the token only when they match. No test here
// can run the hook (it lives in Postgres), so these pin the SQL that makes
// that true.

const schema = readFileSync(path.resolve(__dirname, "../../../supabase/schema.sql"), "utf8");
const hook = schema.slice(
  schema.indexOf("create or replace function public.hook_require_invite"),
  schema.indexOf("revoke execute on function public.hook_require_invite")
);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("public.hook_require_invite", () => {
  it("is found in the schema", () => {
    expect(hook).toContain("returns jsonb");
  });

  it("reads the email from the user Auth is creating, not from anything the client labels", () => {
    expect(squash(hook)).toContain("v_email text := lower(event->'user'->>'email');");
    expect(hook).not.toMatch(/user_metadata'->>'(email|invited_?email)/i);
  });

  it("spends the token in one UPDATE whose WHERE requires the email to match", () => {
    const update = squash(hook.slice(hook.indexOf("update public.invites"), hook.indexOf("if found then")));
    expect(update).toBe(
      "update public.invites set consumed_at = now(), consumed_by = v_user_id where token_hash = v_hash and consumed_at is null and expires_at > now() and email = v_email;"
    );
  });

  it("is the only write: a mismatch reaches the read-only check and leaves the invite unspent", () => {
    expect(hook.match(/\bupdate\b/gi)).toHaveLength(1);
    expect(hook).not.toMatch(/\b(insert|delete)\b/i);
    const afterUpdate = hook.slice(hook.indexOf("if found then"));
    expect(afterUpdate).toContain("'invite_email_mismatch'");
  });
});
