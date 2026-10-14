import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getStoryTimelines } from "@/lib/digests";

// The story timeline's save path: "never fails the save"
// promise on odd embeddings, and the timeline read end to end through a real
// Postgres with RLS: cards persisted by persist_generated_cards across several
// days, read back by the same join getStoryTimelines asks PostgREST for (run
// here as the reader, under RLS), assembled by the real getStoryTimelines.

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

let db: PG;
let alice: string;
let bob: string;

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
  topic: "Geopolitics",
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

async function digestFor(user: string, date: string): Promise<string> {
  return (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date) values (gen_random_uuid(), $1, $2) returning id`, [user, date])).rows[0].id;
}

let spareDay = 0;
/** A fresh digest for Alice on a date no other test uses. */
const spareDigest = () => digestFor(alice, `2020-01-${String(++spareDay).padStart(2, "0")}`);

const persist = (user: string, digest: string, cards: unknown[]) =>
  as(user, `select public.persist_generated_cards(p_digest_id => $1, p_cards => $2::jsonb, p_generated_at => now(), p_existing_rank_updates => '[]'::jsonb, p_units => '[]'::jsonb)`, [
    digest,
    JSON.stringify(cards),
  ]);

/**
 * A supabase-js stand-in for exactly the chain getStoryTimelines builds
 * (.from("cards").select(...).in("story_id", ids).eq("digests.user_id", uid)),
 * answered by the same inner join under the reader's own RLS.
 */
function pgClient(reader: string) {
  const state: { ids: string[]; user: string | null } = { ids: [], user: null };
  const builder = {
    select: () => builder,
    in: (_col: string, ids: string[]) => ((state.ids = ids), builder),
    eq: (_col: string, user: string) => ((state.user = user), builder),
    then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
      as<{ id: string; story_id: string; title: string; topic: string; date: string; user_id: string }>(
        reader,
        `select c.id, c.story_id, c.title, c.topic, d.date::text as date, d.user_id
           from public.cards c join public.digests d on d.id = c.digest_id
          where c.story_id = any($1::uuid[]) and d.user_id = $2`,
        [state.ids, state.user]
      ).then(
        (r) =>
          resolve(
            r.error
              ? { data: null, error: { message: r.error } }
              : { data: r.rows.map(({ date, user_id, ...rest }) => ({ ...rest, digests: { date, user_id } })), error: null }
          ),
        reject
      );
    },
  };
  return { from: () => builder } as never;
}

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
  await db.exec(timelineBlock);
  await db.exec(persistFunction);
  await db.exec(grants);
  alice = (await db.query<{ id: string }>(`insert into auth.users (email) values ('a@x.com') returning id`)).rows[0].id;
  bob = (await db.query<{ id: string }>(`insert into auth.users (email) values ('b@x.com') returning id`)).rows[0].id;
});

describe("persist_generated_cards: an embedding never fails the save (QA)", () => {
  // The migration's promise: anything but the model's 384 numbers "is stored
  // as no embedding rather than failing the run's save". A JSON number outside
  // real's range is still jsonb_typeof 'number', passes the guard, and then
  // the ::real cast raises, failing the whole run's save.
  it.each([
    ["a number above real's range", 1e39],
    ["a number below real's negative range", -1e39],
    ["a number that underflows real", 1e-50],
  ])("stores %s as no embedding rather than failing the save", async (_label, value) => {
    const digest = await spareDigest();
    const v = vector(9);
    v[5] = value;
    const c = card({ embedding: v });
    const r = await persist(alice, digest, [c, card()]);
    expect(r.error).toBeUndefined();
    const row = (await db.query<{ embedding: number[] | null }>(`select embedding from public.cards where id = $1`, [c.id])).rows[0];
    expect(row?.embedding ?? null).toBeNull();
  });

  it("stores real's own extremes and subnormals (what a Float32 can actually hold)", async () => {
    const digest = await spareDigest();
    const v = vector(10);
    v[0] = 3.4028234663852886e38;
    v[1] = 1.401298464324817e-45;
    v[2] = -0;
    const c = card({ embedding: v });
    expect((await persist(alice, digest, [c])).error).toBeUndefined();
    const row = (await db.query<{ embedding: number[] | null }>(`select embedding from public.cards where id = $1`, [c.id])).rows[0];
    expect(row.embedding).toHaveLength(384);
  });

  it("treats a JSON-null storyId as the card's own story", async () => {
    const digest = await spareDigest();
    const c = card({ storyId: null, embedding: vector(1) });
    expect((await persist(alice, digest, [c])).error).toBeUndefined();
    expect((await db.query<{ story_id: string }>(`select story_id from public.cards where id = $1`, [c.id])).rows[0].story_id).toBe(c.id);
  });
});

describe("the timeline read end to end on Postgres (QA)", () => {
  it("builds Day N and the earlier days from what persist_generated_cards stored, scoped to the reader", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d10 = await digestFor(alice, "2026-10-10");
    const d11 = await digestFor(alice, "2026-10-11");
    const d12 = await digestFor(alice, "2026-10-12");
    const d13 = await digestFor(alice, "2026-10-13");
    const root = card({ title: "Talks open in Doha", embedding: vector(1) });
    const story = root.id;
    const day11a = card({ title: "Talks stall", storyId: story, embedding: vector(2) });
    const day11b = card({ title: "Talks stall (second run)", storyId: story, embedding: vector(3) });
    const day12 = card({ title: "Deal close", storyId: story });
    const day13 = card({ title: "Deal agreed", storyId: story });
    const unrelated = card({ title: "Match result" });
    expect((await persist(alice, d10, [root, unrelated])).error).toBeUndefined();
    expect((await persist(alice, d11, [day11a])).error).toBeUndefined();
    expect((await persist(alice, d11, [day11b])).error).toBeUndefined();
    expect((await persist(alice, d12, [day12])).error).toBeUndefined();
    expect((await persist(alice, d13, [day13])).error).toBeUndefined();

    // Bob names Alice's story on his own card: it must never show on her
    // timeline, and her cards must never show on his.
    const bobDigest = await digestFor(bob, "2026-10-12");
    const bobCard = card({ title: "Bob's intruder", storyId: story });
    expect((await persist(bob, bobDigest, [bobCard])).error).toBeUndefined();

    const subjects = [
      { id: root.id, storyId: story, date: "2026-10-10" },
      { id: unrelated.id, storyId: unrelated.id, date: "2026-10-10" },
      { id: day11a.id, storyId: story, date: "2026-10-11" },
      { id: day11b.id, storyId: story, date: "2026-10-11" },
      { id: day12.id, storyId: story, date: "2026-10-12" },
      { id: day13.id, storyId: story, date: "2026-10-13" },
    ];
    const timelines = await getStoryTimelines(pgClient(alice), alice, subjects);
    expect(timelines.has(root.id)).toBe(false);
    expect(timelines.has(unrelated.id)).toBe(false);
    expect(timelines.get(day11a.id)).toEqual({ date: "2026-10-11", day: 2, earlier: [{ id: root.id, date: "2026-10-10", title: "Talks open in Doha", topic: "Geopolitics" }] });
    expect(timelines.get(day11b.id)?.day).toBe(2);
    expect(timelines.get(day12.id)?.day).toBe(3);
    expect(timelines.get(day12.id)?.earlier.map((e) => e.date)).toEqual(["2026-10-10", "2026-10-11"]);
    // One card per earlier day: the first by id of the two Oct 11 cards.
    const firstOf11 = [day11a.id, day11b.id].sort()[0];
    expect(timelines.get(day13.id)).toMatchObject({ day: 4 });
    expect(timelines.get(day13.id)?.earlier.map((e) => e.id)).toEqual([root.id, firstOf11, day12.id]);
    expect(JSON.stringify([...timelines.values()])).not.toMatch(/intruder/);

    const bobs = await getStoryTimelines(pgClient(bob), bob, [{ id: bobCard.id, storyId: story, date: "2026-10-12" }]);
    expect(bobs.size).toBe(0);

    // Even a read that forgot the user filter gets nothing of Alice's, by RLS.
    const leaky = await as<{ id: string }>(bob, `select c.id from public.cards c where c.story_id = $1`, [story]);
    expect(leaky.rows.map((r) => r.id)).toEqual([bobCard.id]);
  });
});
