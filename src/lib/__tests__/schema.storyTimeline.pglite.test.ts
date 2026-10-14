import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// The V2.7 story-timeline migration and the persist_generated_cards it pairs
// with, run on a real Postgres (PGlite, in-process) with Supabase's roles and
// auth.uid() stubbed. The point is the deploy order: the migration runs while
// production still runs the old code, so the old call shape must keep working.

type PG = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const schema = readFileSync(path.resolve(__dirname, "../../../supabase/schema.sql"), "utf8");
function cut(from: string, to: string): string {
  const i = schema.indexOf(from);
  const j = schema.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`cut ${from}`);
  return schema.slice(i, j);
}

const userTopics = cut("create table public.user_topics", "create table public.user_preferred_sources");
const digestsAndCards = cut("create table public.digests", "create table public.bookmarks");
const persistFunction = cut("drop function if exists public.persist_generated_cards(uuid, jsonb, timestamptz);", "-- ensure_digest_for_today");
const grants = cut("revoke execute on function public.persist_generated_cards", "revoke execute on function public.ensure_digest_for_today");
const subtopics = cut("alter table public.cards add column if not exists subtopic text;", "-- V2.6 migration");
const unitReadCursors = cut("create table if not exists public.unit_read_cursors", "begin;\nwith cursors");
const timelineBlock = schema.slice(schema.indexOf("-- V2.7 migration: the story timeline."));

const vector = (seed: number) => Array.from({ length: 384 }, (_, i) => Math.sin(seed + i) / 20);

describe("V2.7 story timeline migration on Postgres (PGlite)", () => {
  let db: PG;
  let alice: string;
  let bob: string;
  let aliceDigest: string;

  async function as<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`);
    try {
      return { rows: (await db.query<T>(sql, params)).rows, error: undefined as string | undefined };
    } catch (e) {
      return { rows: [] as T[], error: (e as Error).message };
    } finally {
      await db.exec("reset role");
    }
  }

  const card = (extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    topic: "Tech/AI",
    title: "A title",
    shortSummary: "A summary.",
    labels: [],
    sources: [],
    publishedAt: new Date().toISOString(),
    severity: 3,
    frontPageRank: null,
    subtopic: null,
    ...extra,
  });

  // The exact shape the code before this lane sends: no embedding, no storyId.
  const oldCallShape = (cards: unknown[]) =>
    as(alice, `select public.persist_generated_cards(p_digest_id => $1, p_cards => $2::jsonb, p_generated_at => now(), p_existing_rank_updates => '[]'::jsonb, p_units => '[]'::jsonb)`, [
      aliceDigest,
      JSON.stringify(cards),
    ]);

  const stored = async (id: string) =>
    (await db.query<{ embedding: number[] | null; story_id: string | null }>(`select embedding, story_id from public.cards where id = $1`, [id])).rows[0];

  beforeAll(async () => {
    db = new PGlite() as unknown as PG;
    await db.exec(`
      create role anon nologin; create role authenticated nologin;
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
      grant usage on schema public to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
      alter default privileges in schema public grant all on functions to anon, authenticated;
    `);
    await db.exec(userTopics);
    await db.exec(digestsAndCards);
    await db.exec(subtopics);
    await db.exec(unitReadCursors);
    alice = (await db.query<{ id: string }>(`insert into auth.users (email) values ('a@x.com') returning id`)).rows[0].id;
    bob = (await db.query<{ id: string }>(`insert into auth.users (email) values ('b@x.com') returning id`)).rows[0].id;
    aliceDigest = (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date) values (gen_random_uuid(), $1, current_date) returning id`, [alice])).rows[0].id;
    // A card written before the migration, by the old function's own insert.
    await db.query(`insert into public.cards (id, digest_id, topic, short_summary, sources, published_at) values ($1, $2, 'Tech/AI', 'old', '[]', now())`, [
      "00000000-0000-4000-8000-000000000001",
      aliceDigest,
    ]);
    await db.exec(timelineBlock);
    await db.exec(persistFunction);
    await db.exec(grants);
  });

  it("adds both columns as nullable and leaves an existing card without them", async () => {
    const cols = (
      await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'cards' and column_name in ('embedding', 'story_id') order by column_name`
      )
    ).rows;
    expect(cols).toEqual([
      { column_name: "embedding", data_type: "ARRAY", is_nullable: "YES" },
      { column_name: "story_id", data_type: "uuid", is_nullable: "YES" },
    ]);
    expect(await stored("00000000-0000-4000-8000-000000000001")).toEqual({ embedding: null, story_id: null });
  });

  it("indexes cards by story id", async () => {
    const idx = (await db.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'cards_story_id_idx'`)).rows;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toMatch(/\(story_id, digest_id\)/);
  });

  it("keeps the old call shape working: no embedding, and the card is its own story", async () => {
    const c = card();
    const r = await oldCallShape([c]);
    expect(r.error).toBeUndefined();
    expect(await stored(c.id)).toEqual({ embedding: null, story_id: c.id });
  });

  it("keeps the four-argument call (no p_units) working too", async () => {
    const c = card();
    const r = await as(alice, `select public.persist_generated_cards($1, $2::jsonb, now(), '[]'::jsonb)`, [aliceDigest, JSON.stringify([c])]);
    expect(r.error).toBeUndefined();
    expect((await stored(c.id)).story_id).toBe(c.id);
  });

  it("stores the new shape's embedding in order and its story id", async () => {
    const story = randomUUID();
    const v = vector(1);
    const c = card({ embedding: v, storyId: story });
    expect((await oldCallShape([c])).error).toBeUndefined();
    const row = await stored(c.id);
    expect(row.story_id).toBe(story);
    expect(row.embedding).toHaveLength(384);
    row.embedding!.forEach((x, i) => expect(x).toBeCloseTo(v[i], 6));
  });

  it("stores anything but 384 numbers as no embedding rather than failing the save", async () => {
    const shapes = [[0.1, 0.2], [...vector(2), 0.5], vector(3).map((x, i) => (i === 7 ? "0.1" : x)), "nope", { a: 1 }, null];
    const cards = shapes.map((embedding) => card({ embedding }));
    expect((await oldCallShape(cards)).error).toBeUndefined();
    for (const c of cards) expect((await stored(c.id)).embedding).toBeNull();
  });

  it("stores a number a real can't hold as no embedding, at either limit, rather than failing the save", async () => {
    const at = (x: number) => vector(9).map((v, i) => (i === 5 ? x : v));
    const cards = [3.41e38, -3.41e38, 5e-46, -5e-46].map((x) => card({ embedding: at(x) }));
    const kept = [3.4028234e38, 1.5e-45, 0].map((x) => card({ embedding: at(x) }));
    expect((await oldCallShape([...cards, ...kept])).error).toBeUndefined();
    for (const c of cards) expect((await stored(c.id)).embedding).toBeNull();
    for (const c of kept) expect((await stored(c.id)).embedding).toHaveLength(384);
  });

  it("saves a card whose story id isn't a uuid as a story of its own", async () => {
    const c = card({ storyId: "not-a-uuid" });
    expect((await oldCallShape([c])).error).toBeUndefined();
    expect((await stored(c.id)).story_id).toBe(c.id);
  });

  it("is safe to re-run", async () => {
    await db.exec(timelineBlock);
    await db.exec(timelineBlock);
    const c = card({ embedding: vector(4) });
    expect((await oldCallShape([c])).error).toBeUndefined();
  });

  it("needs no new policy: another reader sees neither column of someone else's card", async () => {
    const c = card({ embedding: vector(5), storyId: randomUUID() });
    await oldCallShape([c]);
    const theirs = await as(bob, `select embedding, story_id from public.cards where id = $1`, [c.id]);
    expect(theirs.error).toBeUndefined();
    expect(theirs.rows).toEqual([]);
    const mine = await as<{ story_id: string }>(alice, `select story_id from public.cards where id = $1`, [c.id]);
    expect(mine.rows).toHaveLength(1);
  });

  it("still refuses a digest that isn't the caller's", async () => {
    const r = await as(bob, `select public.persist_generated_cards($1, $2::jsonb, now())`, [aliceDigest, JSON.stringify([card({ embedding: vector(6) })])]);
    expect(r.error).toMatch(/does not belong to the caller/);
  });
});
