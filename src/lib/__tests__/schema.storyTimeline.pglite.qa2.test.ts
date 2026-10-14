import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

// persist_generated_cards' embedding guard and storyId check, fed
// RAW JSON text rather than JSON.stringify of JS numbers, so number spellings
// JS never produces (-0, -0.0, 1E-45, 0e-1000, 1e400, 40-digit mantissas) and
// non-number elements reach the CASE exactly as a direct caller could send
// them. The promise under test: anything but 384 numbers a real can hold is
// stored as no embedding, a storyId that isn't a uuid makes the card its own
// story, and neither ever fails the save.

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

let db: PG;
let alice: string;

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

let day = 0;
async function freshDigest(): Promise<string> {
  day += 1;
  const date = `2019-${String(Math.ceil(day / 28)).padStart(2, "0")}-${String(((day - 1) % 28) + 1).padStart(2, "0")}`;
  return (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date) values (gen_random_uuid(), $1, $2) returning id`, [alice, date])).rows[0].id;
}

/** A card's JSON text with `embeddingJson` and `storyIdJson` spliced in verbatim. */
function cardJson(id: string, embeddingJson: string | undefined, storyIdJson?: string): string {
  const base = JSON.stringify({
    id,
    topic: "Geopolitics",
    title: "A title",
    shortSummary: "A summary.",
    labels: [],
    sources: [],
    publishedAt: "2026-10-13T00:00:00.000Z",
    severity: 3,
    frontPageRank: null,
    subtopic: null,
  });
  const extra = [
    embeddingJson === undefined ? null : `"embedding":${embeddingJson}`,
    storyIdJson === undefined ? null : `"storyId":${storyIdJson}`,
  ].filter((x) => x !== null);
  return extra.length === 0 ? base : `${base.slice(0, -1)},${extra.join(",")}}`;
}

/** 384 ordinary numbers with element 5 replaced by the raw token. */
function vectorWith(rawToken: string): string {
  const parts = Array.from({ length: 384 }, (_, i) => String(Math.sin(i) / 20));
  parts[5] = rawToken;
  return `[${parts.join(",")}]`;
}

async function persistRaw(cardsJson: string[]) {
  const digest = await freshDigest();
  return as(
    alice,
    `select public.persist_generated_cards(p_digest_id => $1, p_cards => $2::jsonb, p_generated_at => now(), p_existing_rank_updates => '[]'::jsonb, p_units => '[]'::jsonb)`,
    [digest, `[${cardsJson.join(",")}]`]
  );
}

async function stored(id: string) {
  return (
    await db.query<{ embedding: number[] | null; story_id: string | null; e5: number | null }>(
      `select embedding, story_id, embedding[6] as e5 from public.cards where id = $1`,
      [id]
    )
  ).rows[0];
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
});

describe("the embedding guard on raw JSON number spellings (QA)", () => {
  // Every one of these is a number a real holds (zero, or inside
  // [1.4e-45, 3.4028235e38] in magnitude): the card keeps its embedding.
  it.each([
    ["-0", 0],
    ["-0.0", 0],
    ["-0e10", 0],
    ["0e-1000", 0],
    ["0.000", 0],
    ["1e-45", 1.401298464324817e-45],
    ["1E-45", 1.401298464324817e-45],
    ["-1.0e-45", -1.401298464324817e-45],
    ["3.4028235e38", 3.4028234663852886e38],
    ["-3.4028235E+38", -3.4028234663852886e38],
    ["340282346638528859811704183484516925440", 3.4028234663852886e38],
    ["0.1234567890123456789012345678901234567890", 0.12345679104328156],
    ["1.17549435e-38", 1.1754943508222875e-38],
  ])("keeps %s", async (token, expected) => {
    const id = randomUUID();
    const r = await persistRaw([cardJson(id, vectorWith(token))]);
    expect(r.error).toBeUndefined();
    const row = await stored(id);
    expect(row.embedding).toHaveLength(384);
    expect(Math.fround(row.e5 as number)).toBe(Math.fround(expected));
  });

  // None of these is a number a real holds, or a number at all: stored as no
  // embedding, and the save still succeeds.
  it.each([
    ["1e400"],
    ["-1e400"],
    ["3.40282351e38"],
    ["3.4028235000000000000000000000000000001e38"],
    ["1e-46"],
    ["9.99999e-46"],
    ["-7.1e-46"],
    ["1e-400"],
    ["0.0000000000000000000000000000000000000000000001"],
    ["true"],
    ["null"],
    ['"0.1"'],
    ["[0.1]"],
    ["{}"],
  ])("stores %s as no embedding, without failing the save", async (token) => {
    const id = randomUUID();
    const r = await persistRaw([cardJson(id, vectorWith(token))]);
    expect(r.error).toBeUndefined();
    expect((await stored(id)).embedding).toBeNull();
  });

  it.each([["5"], ["true"], ['"x"'], ["{}"], ["[]"], ["null"], [`[${"[0.1],".repeat(383)}[0.1]]`]])(
    "stores a top-level %s embedding as none, without failing the save",
    async (embeddingJson) => {
      const id = randomUUID();
      const r = await persistRaw([cardJson(id, embeddingJson.length > 40 ? embeddingJson : embeddingJson)]);
      expect(r.error).toBeUndefined();
      expect((await stored(id)).embedding).toBeNull();
    }
  );

  it("judges each card on its own: one bad embedding in a batch leaves its neighbours' intact", async () => {
    const good1 = randomUUID();
    const bad = randomUUID();
    const good2 = randomUUID();
    const r = await persistRaw([cardJson(good1, vectorWith("0.5")), cardJson(bad, vectorWith("1e400")), cardJson(good2, vectorWith("-0"))]);
    expect(r.error).toBeUndefined();
    expect((await stored(good1)).embedding).toHaveLength(384);
    expect((await stored(bad)).embedding).toBeNull();
    expect((await stored(good2)).embedding).toHaveLength(384);
  });

  it("keeps the 384 numbers in their order", async () => {
    const id = randomUUID();
    const values = Array.from({ length: 384 }, (_, i) => i);
    const r = await persistRaw([cardJson(id, JSON.stringify(values))]);
    expect(r.error).toBeUndefined();
    expect((await stored(id)).embedding).toEqual(values);
  });
});

describe("the storyId check against Postgres's own uuid input (QA)", () => {
  const story = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

  it("accepts a canonical uuid in either case, storing it as Postgres prints it", async () => {
    const lower = randomUUID();
    const upper = randomUUID();
    const r = await persistRaw([cardJson(lower, undefined, JSON.stringify(story)), cardJson(upper, undefined, JSON.stringify(story.toUpperCase()))]);
    expect(r.error).toBeUndefined();
    expect((await stored(lower)).story_id).toBe(story);
    expect((await stored(upper)).story_id).toBe(story);
  });

  // Each of these either is no uuid at all, or is a spelling Postgres's uuid
  // input would take but the check deliberately does not: either way the card
  // is a story of its own and the save succeeds. The trailing-newline and
  // embedded-newline cases are the ones a `$` that matched before a newline
  // would let through to a cast that then fails the save.
  it.each([
    [`"${story}\\n"`],
    [`"${story}\\n${story}"`],
    [`"\\n${story}"`],
    [`" ${story}"`],
    [`"${story} "`],
    [`"{${story}}"`],
    [`"${story.replace(/-/g, "")}"`],
    [`"${story.slice(0, -1)}g"`],
    [`"${story}0"`],
    ['""'],
    ["5"],
    ["true"],
    ["{}"],
    [`["${story}"]`],
  ])("makes the card its own story for storyId %s", async (storyIdJson) => {
    const id = randomUUID();
    const r = await persistRaw([cardJson(id, undefined, storyIdJson)]);
    expect(r.error).toBeUndefined();
    expect((await stored(id)).story_id).toBe(id);
  });

  it("agrees with Postgres's uuid input on every string it accepts", async () => {
    // Whatever the regex accepts must cast; probe the regex directly against
    // a spread of strings and cast each accepted one.
    const probes = [story, story.toUpperCase(), `${story}\n`, `{${story}}`, story.replace(/-/g, ""), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", `${story.slice(0, 8)}-${story.slice(9)}`];
    const regex = schema.match(/when c->>'storyId' ~\* '([^']+)'/)?.[1];
    expect(regex).toBeDefined();
    for (const p of probes) {
      const accepted = (await db.query<{ ok: boolean }>(`select $1 ~* $2 as ok`, [p, regex])).rows[0].ok;
      if (accepted) {
        await expect(db.query(`select $1::uuid`, [p])).resolves.toBeDefined();
      }
    }
  });
});
