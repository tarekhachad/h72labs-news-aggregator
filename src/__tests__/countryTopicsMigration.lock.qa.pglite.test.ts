import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

// The lock the V2.7 single-country-topic block takes. PGlite is
// one connection, so a second session can't be made to wait; what it can
// prove is which lock the block holds, on which tables, for how long, and
// that the mode's conflicts (from Postgres's own conflict table, which PGlite
// is the real code of) cover the writes a profile save sends and leave reads
// and persist_generated_cards' cursor insert alone.

type PG = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const schema = readFileSync(path.resolve(__dirname, "../../supabase/schema.sql"), "utf8");
const MARKER = "-- V2.7 migration: the six single-country topics become their countries.";
const block = schema.slice(schema.indexOf(MARKER));

let db: PG;

beforeEach(async () => {
  db = new PGlite() as unknown as PG;
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create role supabase_auth_admin nologin;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  await db.exec(schema);
});

// PGlite is one backend and reports pid as null, so every granted lock is this session's.
type LockRow = { rel: string; mode: string };
const heldLocks = async () =>
  (
    await db.query<LockRow>(
      `select c.relname as rel, l.mode from pg_locks l join pg_class c on c.oid = l.relation
       where l.granted and c.relnamespace = 'public'::regnamespace
         and c.relkind = 'r' order by 1, 2`
    )
  ).rows;

describe("the lock the block takes", () => {
  it("holds share row exclusive on user_topics and user_subtopics until commit, and nothing stronger anywhere", async () => {
    const uid = randomUUID();
    await db.query(`insert into auth.users (id) values ($1)`, [uid]);
    await db.query(`insert into public.user_topics (user_id, topic) values ($1, 'US Politics'), ($1, 'Science'), ($1, 'Space')`, [uid]);
    const d = (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date) values (gen_random_uuid(), $1, '2026-10-10') returning id`, [uid])).rows[0].id;
    await db.query(`insert into public.cards (id, digest_id, topic, short_summary, sources, published_at) values (gen_random_uuid(), $1, 'US Politics', 's', '[]', now())`, [d]);

    const body = block.slice(0, block.lastIndexOf("commit;"));
    expect(block.slice(block.lastIndexOf("commit;")).trim()).toBe("commit;");
    await db.exec(body);
    const held = await heldLocks();
    const byTable = (t: string) => held.filter((l) => l.rel === t).map((l) => l.mode);
    expect(byTable("user_topics")).toContain("ShareRowExclusiveLock");
    expect(byTable("user_subtopics")).toContain("ShareRowExclusiveLock");
    // Row writes only on the other two tables: no table lock a SELECT waits on.
    expect(byTable("unit_read_cursors")).toEqual(["RowExclusiveLock"]);
    expect(byTable("cards")).toEqual(["RowExclusiveLock"]);
    for (const l of held) expect(["AccessShareLock", "RowExclusiveLock", "ShareRowExclusiveLock"]).toContain(l.mode);
    await db.exec("commit");
    expect(await heldLocks()).toEqual([]);
  });

  it("takes the lock before it reads or writes either table", () => {
    const begin = block.indexOf("begin;");
    const lock = block.indexOf("lock table public.user_topics, public.user_subtopics in share row exclusive mode;");
    const firstTouch = Math.min(
      ...["from public.user_topics", "from public.user_subtopics", "into public.user_topics", "into public.user_subtopics"].map((s) => block.indexOf(s)).filter((i) => i >= 0)
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(lock).toBeLessThan(firstTouch);
  });

  it("releases the lock at commit, so a second run in the same session takes it again", async () => {
    await db.exec(block);
    await db.exec(block);
    expect(await heldLocks()).toEqual([]);
  });
});
