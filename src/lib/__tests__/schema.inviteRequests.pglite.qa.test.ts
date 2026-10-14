import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { hashServerKey, sourceHash } from "@/lib/inviteRequest";
import { hashInviteToken } from "@/lib/invite";

// The V2.7 SQL block run on a real Postgres (PGlite, in-process), with
// Supabase's roles, default privileges, auth.users and auth.uid() stubbed.
// Exercises who can reach what, the caps, the decisions, and the invite
// hook accepting an approved request's token.
//
// Imported statically, so a missing PGlite fails the run instead of skipping
// the one suite that checks the database's own gates.

type PG = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
};


const schema = readFileSync(path.resolve(__dirname, "../../../supabase/schema.sql"), "utf8");
function cut(from: string, to: string): string {
  const i = schema.indexOf(from);
  const j = schema.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`cut ${from}`);
  return schema.slice(i, j);
}
const invitesBlock = cut("create table public.invites", "-- spend_config + spend_ledger");
const requestsBlock = cut("-- V2.7 migration: invite requests.", "-- V2.7 migration: the story timeline.");

const KEY = "s".repeat(48);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("V2.7 invite requests on Postgres (PGlite)", () => {
  let db: PG;
  let admin: string;
  let reader: string;

  async function as<T = Record<string, unknown>>(role: string, uid: string | null, sql: string, params: unknown[] = []) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false); set role ${role};`);
    try {
      return { rows: (await db.query<T>(sql, params)).rows, error: undefined as string | undefined };
    } catch (e) {
      return { rows: [] as T[], error: (e as Error).message };
    } finally {
      await db.exec("reset role");
    }
  }

  const submit = (email: string, opts: { key?: string | null; source?: string | null; role?: string; name?: string; note?: string } = {}) =>
    as<{ r: string }>(
      opts.role ?? "anon",
      null,
      `select public.submit_invite_request($1,$2,$3,$4,'friend','tech',$5,'') as r`,
      [opts.key === undefined ? KEY : opts.key, opts.source ?? null, opts.name ?? "Ann", email, opts.note ?? "curious"]
    );
  const outcome = async (...args: Parameters<typeof submit>) => {
    const r = await submit(...args);
    return r.error ?? r.rows[0]?.r;
  };
  const idOf = async (email: string, status = "pending") =>
    (await db.query<{ id: string }>(`select id from public.invite_requests where email = $1 and status = $2`, [email, status])).rows[0]?.id;
  const approve = (uid: string | null, id: string, hash: string, role = "authenticated") =>
    as<{ email: string; name: string; expires_at: Date }>(role, uid, `select * from public.approve_invite_request($1, $2)`, [id, hash]);
  const decline = (uid: string | null, id: string, role = "authenticated") =>
    as<{ email: string; name: string }>(role, uid, `select * from public.decline_invite_request($1)`, [id]);
  const hook = async (email: string, token: string) =>
    (
      await db.query<{ r: Record<string, unknown> }>(`select public.hook_require_invite($1::jsonb) as r`, [
        JSON.stringify({ user: { id: randomUUID(), email, user_metadata: { invite_token: token } } }),
      ])
    ).rows[0].r;
  const reset = async (dailyCap = 100, perSource = 100) => {
    await db.exec(`truncate public.invite_requests; delete from public.invites;`);
    await db.query(`update public.invite_request_config set daily_cap = $1, per_source_daily_cap = $2`, [dailyCap, perSource]);
  };

  beforeAll(async () => {
    db = new PGlite() as unknown as PG;
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role supabase_auth_admin nologin;
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
      grant usage on schema public to anon, authenticated;
      -- Supabase's defaults for objects created in public: everything granted
      -- to the API roles unless revoked.
      alter default privileges in schema public grant all on tables to anon, authenticated;
      alter default privileges in schema public grant all on functions to anon, authenticated;
    `);
    await db.exec(invitesBlock);
    await db.exec(requestsBlock);
    admin = (await db.query<{ id: string }>(`insert into auth.users (email) values ('admin@x.com') returning id`)).rows[0].id;
    reader = (await db.query<{ id: string }>(`insert into auth.users (email) values ('reader@x.com') returning id`)).rows[0].id;
    await db.query(`insert into public.app_admins (user_id) values ($1)`, [admin]);
    await db.query(`insert into public.invite_request_config (server_key_hash) values ($1)`, [hashServerKey(KEY)]);
  });

  describe("the server key", () => {
    it("is required, as the app hashes it", async () => {
      await reset();
      expect(await outcome("a@x.com", { key: null })).toBe("forbidden");
      expect(await outcome("a@x.com", { key: "" })).toBe("forbidden");
      expect(await outcome("a@x.com", { key: KEY + " " })).toBe("forbidden");
      expect(await outcome("a@x.com", { key: hashServerKey(KEY) })).toBe("forbidden");
      expect(await outcome("a@x.com")).toBe("created");
      expect(await outcome("b@x.com", { role: "authenticated" })).toBe("created");
    });

    it("cannot be replaced by a client: config, admins and requests are closed to both API roles", async () => {
      for (const role of ["anon", "authenticated"]) {
        for (const sql of [
          `update public.invite_request_config set server_key_hash = '${sha("mine")}'`,
          `insert into public.invite_request_config (id, server_key_hash) values (1, '${sha("mine")}')`,
          `delete from public.invite_request_config`,
          `select server_key_hash from public.invite_request_config`,
          `insert into public.app_admins (user_id) values ('${reader}')`,
          `select * from public.app_admins`,
          `select * from public.invite_requests`,
          `update public.invite_requests set status = 'declined', decided_at = now()`,
          `delete from public.invite_requests`,
          `insert into public.invite_requests (name,email,referral,interests,note,had_account) values ('n','z@x.com','r','i','n',false)`,
          `select * from public.invites`,
          `insert into public.invites (token_hash,email,label,expires_at) values ('${sha("t")}','z@x.com','l',now()+interval '1 day')`,
        ]) {
          const r = await as(role, reader, sql);
          expect(r.error, `${role}: ${sql}`).toMatch(/permission denied/);
        }
      }
      expect((await db.query(`select server_key_hash from public.invite_request_config`)).rows[0]).toEqual({
        server_key_hash: hashServerKey(KEY),
      });
    });

    it("refuses everything when the config row is missing", async () => {
      await db.exec(`delete from public.invite_request_config`);
      try {
        expect(await outcome("c@x.com")).toBe("forbidden");
      } finally {
        await db.query(`insert into public.invite_request_config (server_key_hash) values ($1)`, [hashServerKey(KEY)]);
      }
    });
  });

  describe("caps", () => {
    it("counts only the last 24 hours", async () => {
      await reset(2, 100);
      await db.exec(`
        insert into public.invite_requests (created_at, name, email, referral, interests, note, had_account, status, decided_at)
        select now() - interval '25 hours', 'old', 'old' || g || '@x.com', 'r', 'i', 'n', false, 'declined', now()
        from generate_series(1, 5) g;
      `);
      expect(await outcome("a@x.com")).toBe("created");
      expect(await outcome("b@x.com")).toBe("created");
      expect(await outcome("c@x.com")).toBe("closed");
    });

    it("counts decided requests toward the daily cap", async () => {
      await reset(1, 100);
      expect(await outcome("a@x.com")).toBe("created");
      expect((await decline(admin, (await idOf("a@x.com"))!)).error).toBeUndefined();
      expect(await outcome("b@x.com")).toBe("closed");
    });

    it("closes completely at a cap of zero", async () => {
      await reset(0, 0);
      expect(await outcome("a@x.com")).toBe("closed");
      await reset(100, 0);
      expect(await outcome("a@x.com", { source: sourceHash("1.2.3.4", KEY) })).toBe("rate_limited");
      expect(await outcome("a@x.com", { source: null })).toBe("created");
    });

    it("limits one source, and not another", async () => {
      await reset(100, 2);
      const s1 = sourceHash("1.2.3.4", KEY)!;
      const s2 = sourceHash("5.6.7.8", KEY)!;
      expect(await outcome("a@x.com", { source: s1 })).toBe("created");
      expect(await outcome("b@x.com", { source: s1 })).toBe("created");
      expect(await outcome("c@x.com", { source: s1 })).toBe("rate_limited");
      expect(await outcome("c@x.com", { source: s2 })).toBe("created");
    });

    it("refuses a source hash that is not 64 hex characters", async () => {
      await reset();
      expect(await outcome("a@x.com", { source: "1.2.3.4" })).toMatch(/check constraint/);
    });
  });

  describe("duplicates", () => {
    it("normalises the email and answers a pending repeat as duplicate without writing", async () => {
      await reset();
      expect(await outcome(" Ann@X.com ")).toBe("created");
      expect(await outcome("ann@x.com", { name: "Someone else" })).toBe("duplicate");
      const rows = (await db.query(`select email, name from public.invite_requests`)).rows;
      expect(rows).toEqual([{ email: "ann@x.com", name: "Ann" }]);
    });

    it("lets a declined or approved email ask again", async () => {
      await reset();
      await outcome("a@x.com");
      await decline(admin, (await idOf("a@x.com"))!);
      expect(await outcome("a@x.com")).toBe("created");
      await approve(admin, (await idOf("a@x.com"))!, sha(randomBytes(8).toString("hex")));
      expect(await outcome("a@x.com")).toBe("created");
    });
  });

  describe("admin functions", () => {
    it("are not executable by anon at all, even with Supabase's default grants", async () => {
      await reset();
      await outcome("a@x.com");
      const id = (await idOf("a@x.com"))!;
      for (const sql of [
        `select public.pending_invite_request_count()`,
        `select * from public.list_invite_requests()`,
        `select * from public.approve_invite_request('${id}', '${sha("x")}')`,
        `select * from public.decline_invite_request('${id}')`,
        `select public.hook_require_invite('{}'::jsonb)`,
      ]) {
        expect((await as("anon", null, sql)).error, sql).toMatch(/permission denied/);
      }
    });

    it("refuse a signed-in reader who is not an admin, and leave the row untouched", async () => {
      await reset();
      await outcome("a@x.com");
      const id = (await idOf("a@x.com"))!;
      expect((await as<{ n: number | null }>("authenticated", reader, `select public.pending_invite_request_count() as n`)).rows[0].n).toBeNull();
      expect((await as("authenticated", reader, `select * from public.list_invite_requests()`)).error).toBe("not_admin");
      expect((await approve(reader, id, sha("x"))).error).toBe("not_admin");
      expect((await decline(reader, id)).error).toBe("not_admin");
      expect((await as("authenticated", null, `select * from public.list_invite_requests()`)).error).toBe("not_admin");
      expect((await db.query(`select status from public.invite_requests where id = $1`, [id])).rows[0]).toEqual({ status: "pending" });
      expect((await db.query(`select count(*)::int as n from public.invites`)).rows[0]).toEqual({ n: 0 });
      expect((await as("authenticated", reader, `select public.hook_require_invite('{}'::jsonb)`)).error).toMatch(/permission denied/);
    });

    it("count only pending requests for the admin", async () => {
      await reset();
      await outcome("a@x.com");
      await outcome("b@x.com");
      await outcome("c@x.com");
      await decline(admin, (await idOf("c@x.com"))!);
      expect((await as<{ n: number }>("authenticated", admin, `select public.pending_invite_request_count() as n`)).rows[0].n).toBe(2);
    });
  });

  describe("approve and the invite hook", () => {
    it("mints an invite the hook accepts once, for that email only", async () => {
      await reset();
      await outcome("Ann@X.com");
      const id = (await idOf("ann@x.com"))!;
      const token = randomBytes(32).toString("base64url");
      const ap = await approve(admin, id, hashInviteToken(token));
      expect(ap.error).toBeUndefined();
      expect(ap.rows[0]).toMatchObject({ email: "ann@x.com", name: "Ann" });

      const stored = (await db.query<Record<string, unknown>>(`select * from public.invites`)).rows;
      expect(stored).toHaveLength(1);
      // Only the hash is stored.
      expect(JSON.stringify(stored)).not.toContain(token);

      expect(await hook("someone@else.com", token)).toEqual({ error: { http_code: 403, message: "invite_email_mismatch" } });
      expect(await hook("ann@x.com", token)).toEqual({});
      expect(await hook("ann@x.com", token)).toEqual({ error: { http_code: 403, message: "invite_invalid" } });

      const list = await as<{ status: string; invite_consumed_at: Date | null; decided_at: Date | null }>(
        "authenticated",
        admin,
        `select status, invite_consumed_at, decided_at from public.list_invite_requests()`
      );
      expect(list.rows[0].status).toBe("approved");
      expect(list.rows[0].invite_consumed_at).not.toBeNull();
      expect((await db.query(`select decided_by from public.invite_requests where id = $1`, [id])).rows[0]).toEqual({ decided_by: admin });
    });

    it("an expired approved invite is refused by the hook", async () => {
      await reset();
      await outcome("b@x.com");
      const token = randomBytes(32).toString("base64url");
      await approve(admin, (await idOf("b@x.com"))!, hashInviteToken(token));
      await db.exec(`update public.invites set expires_at = now() - interval '1 second'`);
      expect(await hook("b@x.com", token)).toEqual({ error: { http_code: 403, message: "invite_invalid" } });
    });

    it("a declined request leaves no invite for the hook to accept", async () => {
      await reset();
      await outcome("c@x.com");
      const id = (await idOf("c@x.com"))!;
      const token = randomBytes(32).toString("base64url");
      expect((await decline(admin, id)).rows[0]).toEqual({ email: "c@x.com", name: "Ann" });
      expect((await approve(admin, id, hashInviteToken(token))).error).toBe("not_pending");
      expect((await db.query(`select count(*)::int as n from public.invites`)).rows[0]).toEqual({ n: 0 });
      expect(await hook("c@x.com", token)).toEqual({ error: { http_code: 403, message: "invite_invalid" } });
    });

    it("decides a request once: approve twice, decline after approve, decline twice", async () => {
      await reset();
      await outcome("d@x.com");
      const id = (await idOf("d@x.com"))!;
      expect((await approve(admin, id, sha("t1"))).error).toBeUndefined();
      expect((await approve(admin, id, sha("t2"))).error).toBe("not_pending");
      expect((await decline(admin, id)).error).toBe("not_pending");
      expect((await db.query(`select count(*)::int as n from public.invites`)).rows[0]).toEqual({ n: 1 });
    });

    it("refuses an unknown id as not_pending", async () => {
      expect((await approve(admin, randomUUID(), sha("t"))).error).toBe("not_pending");
      expect((await decline(admin, randomUUID())).error).toBe("not_pending");
    });

    it("refuses a malformed token hash, and an email with an account, writing nothing", async () => {
      await reset();
      await outcome("reader@x.com");
      await outcome("e@x.com");
      const rid = (await idOf("reader@x.com"))!;
      expect((await approve(admin, (await idOf("e@x.com"))!, "ABC")).error).toBe("bad_token_hash");
      expect((await approve(admin, (await idOf("e@x.com"))!, sha("x").toUpperCase())).error).toBe("bad_token_hash");
      expect((await approve(admin, rid, sha("x"))).error).toBe("has_account");
      expect((await db.query(`select count(*)::int as n from public.invites`)).rows[0]).toEqual({ n: 0 });
      expect((await db.query(`select count(*)::int as n from public.invite_requests where status = 'pending'`)).rows[0]).toEqual({ n: 2 });
    });

    it("rolls back the decision when the invite insert fails (a reused token hash)", async () => {
      await reset();
      await outcome("f@x.com");
      await outcome("g@x.com");
      expect((await approve(admin, (await idOf("f@x.com"))!, sha("same"))).error).toBeUndefined();
      const second = await approve(admin, (await idOf("g@x.com"))!, sha("same"));
      expect(second.error).toMatch(/duplicate key/);
      expect((await db.query(`select status from public.invite_requests where email = 'g@x.com'`)).rows[0]).toEqual({ status: "pending" });
    });
  });

  describe("list_invite_requests", () => {
    it("shows every pending request the badge counts", async () => {
      await reset(1000, 1000);
      // One old pending request, then 200 newer decided ones.
      await db.exec(`
        insert into public.invite_requests (created_at, name, email, referral, interests, note, had_account)
        values (now() - interval '30 days', 'Oldest', 'oldest@x.com', 'r', 'i', 'n', false);
        insert into public.invite_requests (created_at, name, email, referral, interests, note, had_account, status, decided_at)
        select now() - (g || ' minutes')::interval, 'n', 'd' || g || '@x.com', 'r', 'i', 'n', false, 'declined', now()
        from generate_series(1, 200) g;
      `);
      const count = (await as<{ n: number }>("authenticated", admin, `select public.pending_invite_request_count() as n`)).rows[0].n;
      const listed = (await as<{ email: string; status: string }>("authenticated", admin, `select email, status from public.list_invite_requests()`)).rows;
      const listedPending = listed.filter((r) => r.status === "pending").length;
      expect(count).toBe(1);
      expect(listedPending, "pending requests the admin page can show").toBe(count);
    });

    it("puts every pending request first, then the rest, each part newest first", async () => {
      await reset(1000, 1000);
      // Pending and decided interleaved in time, oldest first:
      // p-old (pending), d-mid (declined), p-new (pending), a-newest (approved).
      await db.exec(`
        insert into public.invite_requests (created_at, name, email, referral, interests, note, had_account)
        values (now() - interval '4 days', 'n', 'p-old@x.com', 'r', 'i', 'n', false),
               (now() - interval '2 days', 'n', 'p-new@x.com', 'r', 'i', 'n', false);
        insert into public.invite_requests (created_at, name, email, referral, interests, note, had_account, status, decided_at)
        values (now() - interval '3 days', 'n', 'd-mid@x.com', 'r', 'i', 'n', false, 'declined', now()),
               (now() - interval '1 day', 'n', 'a-newest@x.com', 'r', 'i', 'n', false, 'approved', now());
      `);
      const listed = (await as<{ email: string }>("authenticated", admin, `select email from public.list_invite_requests()`)).rows;
      expect(listed.map((r) => r.email)).toEqual(["p-new@x.com", "p-old@x.com", "a-newest@x.com", "d-mid@x.com"]);
    });

    it("counts, for each request, only this email's requests made before it", async () => {
      await reset(1000, 1000);
      // Three requests from one address over time (two decided, one pending),
      // and one from another address that must not be counted.
      await db.exec(`
        insert into public.invite_requests (created_at, name, email, referral, interests, note, had_account, status, decided_at)
        values (now() - interval '3 days', 'n', 'ann@x.com', 'r', 'i', 'n', false, 'declined', now()),
               (now() - interval '2 days', 'n', 'ann@x.com', 'r', 'i', 'n', false, 'declined', now()),
               (now() - interval '5 days', 'n', 'bob@x.com', 'r', 'i', 'n', false, 'declined', now());
        insert into public.invite_requests (created_at, name, email, referral, interests, note, had_account)
        values (now() - interval '1 day', 'n', 'ann@x.com', 'r', 'i', 'n', false);
      `);
      const listed = (
        await as<{ email: string; status: string; earlier_requests: number; created_at: Date }>(
          "authenticated",
          admin,
          `select email, status, earlier_requests, created_at from public.list_invite_requests()`
        )
      ).rows;
      const ann = listed.filter((r) => r.email === "ann@x.com").sort((a, b) => +a.created_at - +b.created_at);
      expect(ann.map((r) => r.earlier_requests), "oldest to newest").toEqual([0, 1, 2]);
      expect(ann[2].status).toBe("pending");
      expect(listed.find((r) => r.email === "bob@x.com")!.earlier_requests).toBe(0);
    });

    it("refuses a NUL character in the text the app sends (why the form rejects it first)", async () => {
      await reset();
      const r = await submit("nul@x.com", { note: "a\u0000b" });
      expect(r.error).toMatch(/0x00/);
      expect((await db.query(`select count(*)::int as n from public.invite_requests`)).rows[0]).toEqual({ n: 0 });
    });
  });

  describe("re-running the block", () => {
    it("keeps the data and the config, and restates every grant", async () => {
      await reset();
      await outcome("h@x.com");
      await db.exec(requestsBlock);
      await db.exec(requestsBlock);
      expect((await db.query(`select count(*)::int as n from public.invite_requests`)).rows[0]).toEqual({ n: 1 });
      expect((await db.query(`select count(*)::int as n from public.invite_request_config`)).rows[0]).toEqual({ n: 1 });
      expect((await db.query(`select count(*)::int as n from public.app_admins`)).rows[0]).toEqual({ n: 1 });
      expect((await as("anon", null, `select * from public.list_invite_requests()`)).error).toMatch(/permission denied/);
      expect((await as("anon", null, `select * from public.invite_requests`)).error).toMatch(/permission denied/);
      expect(await outcome("i@x.com")).toBe("created");
    });
  });
});
