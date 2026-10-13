import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INVITE_TTL_DAYS } from "@/lib/invite";
import { REQUEST_LIMITS } from "@/lib/inviteRequest";

// The block's behaviour on real rows was proved in PGlite when it was
// written (server key, caps, admin gate, approve and the hook accepting the
// minted token). These pin the properties a later edit could quietly break.

const schema = readFileSync(path.resolve(__dirname, "../../../supabase/schema.sql"), "utf8");
const block = schema.slice(schema.indexOf("-- V2.7 migration: invite requests."));
const squash = (s: string) => s.replace(/\s+/g, " ");

function fn(name: string): string {
  const start = block.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return block.slice(start, block.indexOf("$$;", start));
}

const FUNCTIONS = [
  "submit_invite_request",
  "pending_invite_request_count",
  "list_invite_requests",
  "approve_invite_request",
  "decline_invite_request",
];

describe("V2.7 migration: invite requests", () => {
  it("runs every function as definer with an empty search_path", () => {
    for (const name of FUNCTIONS) {
      const body = fn(name);
      expect(body, name).toContain("security definer");
      expect(body, name).toContain("set search_path = ''");
    }
  });

  it("checks app_admins against auth.uid() in every admin function", () => {
    for (const name of FUNCTIONS.slice(1)) {
      expect(squash(fn(name)), name).toMatch(/from public\.app_admins( a)? where (a\.)?user_id = auth\.uid\(\)/);
    }
  });

  it("refuses a submission without the server key before reading anything else", () => {
    const body = squash(fn("submit_invite_request"));
    const keyCheck = body.indexOf("encode(sha256(convert_to(p_server_key, 'UTF8')), 'hex') <> v_cfg.server_key_hash");
    expect(keyCheck).toBeGreaterThan(-1);
    expect(keyCheck).toBeLessThan(body.indexOf("from public.invite_requests"));
  });

  it("checks both caps before the duplicate, so a closed form's answer does not depend on the email", () => {
    const body = fn("submit_invite_request");
    const duplicate = body.indexOf("return 'duplicate'");
    expect(body.indexOf("return 'closed'")).toBeLessThan(duplicate);
    expect(body.indexOf("return 'rate_limited'")).toBeLessThan(duplicate);
  });

  it("gives an approved invite the same lifetime as npm run invite", () => {
    expect(fn("approve_invite_request")).toContain(`now() + interval '${INVITE_TTL_DAYS} days'`);
  });

  it("matches the form's length limits", () => {
    const table = squash(block.slice(block.indexOf("create table if not exists public.invite_requests"), block.indexOf("create unique index")));
    expect(table).toContain(`char_length(btrim(name)) between 1 and ${REQUEST_LIMITS.name}`);
    expect(table).toContain(`char_length(email) between 3 and ${REQUEST_LIMITS.email}`);
    expect(table).toContain(`char_length(btrim(referral)) between 1 and ${REQUEST_LIMITS.referral}`);
    expect(table).toContain(`char_length(btrim(interests)) between 1 and ${REQUEST_LIMITS.interests}`);
    expect(table).toContain(`char_length(btrim(note)) between 1 and ${REQUEST_LIMITS.note}`);
    expect(table).toContain(`char_length(link) <= ${REQUEST_LIMITS.link}`);
  });

  it("revokes every table from client roles", () => {
    for (const table of ["app_admins", "invite_request_config", "invite_requests"]) {
      expect(block).toContain(`revoke all on table public.${table} from anon, authenticated;`);
      expect(block).toContain(`alter table public.${table} enable row level security;`);
      expect(block).not.toMatch(new RegExp(`create policy[^;]+on public\\.${table}\\b`));
    }
  });

  it("grants only the submit function to anon", () => {
    const anonGrants = [...block.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);/g)]
      .filter(([, , roles]) => roles.includes("anon"))
      .map(([, name]) => name);
    expect(anonGrants).toEqual(["submit_invite_request"]);
    for (const name of FUNCTIONS.slice(1)) {
      expect(block).toMatch(new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon;`));
    }
  });
});
