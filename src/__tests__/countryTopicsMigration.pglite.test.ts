import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { TOPICS } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countryNames";
import { MAX_READING_UNITS, countReadingUnits } from "@/lib/readingUnits";

// The V2.7 block that turns the six single-country topics into their
// countries, cut straight from supabase/schema.sql and run on a real Postgres
// (PGlite, in-process) over rows shaped like production's: holders of one or
// two removed topics, holders who already had the country, readers at the
// 10-unit limit, inert country rows, cards on several days with bookmarks,
// ranks and stories, and read times.

type PG = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const schema = readFileSync(path.resolve(__dirname, "../../supabase/schema.sql"), "utf8");
function cut(from: string, to: string): string {
  const i = schema.indexOf(from);
  const j = schema.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`cut ${from}`);
  return schema.slice(i, j);
}

const MARKER = "-- V2.7 migration: the six single-country topics become their countries.";
const block = schema.slice(schema.indexOf(MARKER));

/** The mapping the block must carry, held here so a drift on either side fails. */
const RETIRED: Record<string, string> = {
  "US Politics": "United States",
  "US Finance": "United States",
  "UK Politics": "United Kingdom",
  "French Politics": "France",
  "Morocco Politics": "Morocco",
  "Morocco Finance": "Morocco",
};
const RETIRED_TOPICS = Object.keys(RETIRED);

/** What getUserProfile and the pickers count, for the catalog before or after the removal. */
function unitsFor(catalog: readonly string[], topics: string[], countries: string[]): number {
  const known = topics.filter((topic) => catalog.includes(topic));
  return countReadingUnits(known, known.includes(COUNTRIES_TOPIC) ? countries : []);
}
const CATALOG_AFTER: readonly string[] = TOPICS;
const CATALOG_BEFORE: readonly string[] = [...TOPICS, ...RETIRED_TOPICS];

let db: PG;

async function freshDb(): Promise<PG> {
  const pg = new PGlite() as unknown as PG;
  await pg.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  await pg.exec(cut("create table public.user_topics", "create table public.user_preferred_sources"));
  await pg.exec(cut("create table public.digests", "create table public.bookmarks"));
  await pg.exec(cut("create table public.bookmarks", "alter table public.bookmarks"));
  await pg.exec(cut("alter table public.cards add column if not exists subtopic text;", "-- V2.6 migration"));
  await pg.exec(cut("create table if not exists public.unit_read_cursors", "begin;\nwith cursors"));
  await pg.exec(cut("alter table public.cards add column if not exists embedding real[];", "-- Serves the timeline read"));
  return pg;
}

async function user(topics: string[], countries: string[] = [], other: [string, string][] = []): Promise<string> {
  const id = (await db.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [`${randomUUID()}@x.com`])).rows[0].id;
  for (const topic of topics) await db.query(`insert into public.user_topics (user_id, topic) values ($1, $2)`, [id, topic]);
  for (const country of countries)
    await db.query(`insert into public.user_subtopics (user_id, topic, subtopic) values ($1, 'Countries', $2)`, [id, country]);
  for (const [topic, subtopic] of other)
    await db.query(`insert into public.user_subtopics (user_id, topic, subtopic) values ($1, $2, $3)`, [id, topic, subtopic]);
  return id;
}

async function profile(id: string): Promise<{ topics: string[]; countries: string[]; subtopics: [string, string][] }> {
  const topics = (await db.query<{ topic: string }>(`select topic from public.user_topics where user_id = $1 order by topic`, [id])).rows.map((r) => r.topic);
  const rows = (await db.query<{ topic: string; subtopic: string }>(`select topic, subtopic from public.user_subtopics where user_id = $1 order by topic, subtopic`, [id])).rows;
  return {
    topics,
    countries: rows.filter((r) => r.topic === COUNTRIES_TOPIC).map((r) => r.subtopic),
    subtopics: rows.map((r) => [r.topic, r.subtopic]),
  };
}

async function digest(userId: string, date: string): Promise<string> {
  return (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date) values (gen_random_uuid(), $1, $2) returning id`, [userId, date])).rows[0].id;
}

async function card(digestId: string, topic: string, extra: { subtopic?: string; rank?: number } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.cards (id, digest_id, topic, subtopic, short_summary, sources, published_at, front_page_rank, story_id)
     values ($1, $2, $3, $4, 'summary', '[]', now(), $5, $1)`,
    [id, digestId, topic, extra.subtopic ?? null, extra.rank ?? null]
  );
  return id;
}

async function snapshot(): Promise<unknown> {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    topics: await q(`select user_id, topic from public.user_topics order by 1, 2`),
    subtopics: await q(`select user_id, topic, subtopic from public.user_subtopics order by 1, 2, 3`),
    cursors: await q(`select user_id, topic, subtopic, read_at from public.unit_read_cursors order by 1, 2, 3`),
    cards: await q(`select id, digest_id, topic, subtopic, front_page_rank, story_id from public.cards order by 1`),
    bookmarks: await q(`select user_id, card_id from public.bookmarks order by 1, 2`),
  };
}

const migrate = () => db.exec(block);

beforeEach(async () => {
  db = await freshDb();
});

describe("the block itself", () => {
  it("is the last thing in schema.sql and runs as one transaction", () => {
    expect(schema.indexOf(MARKER)).toBeGreaterThan(-1);
    const sql = block.slice(block.indexOf("\nbegin;"));
    expect(sql.startsWith("\nbegin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql.match(/\bbegin;/g)).toHaveLength(1);
    expect(sql.match(/\bcommit;/g)).toHaveLength(1);
  });

  // A profile save is a delete then an insert, in separate requests; one
  // landing between the block's inserts and its deletes could leave a reader
  // one unit over the limit. The lock makes saves wait for the commit.
  // persist_generated_cards updates a card's rank, then upserts the unit's
  // read time; taking cards then read times in the same order here means an
  // old-code digest saving mid-migration can't deadlock with the block.
  it("refiles cards before it deletes read times", () => {
    const update = block.indexOf("update public.cards c");
    const cursors = block.indexOf("delete from public.unit_read_cursors");
    expect(update).toBeGreaterThan(-1);
    expect(cursors).toBeGreaterThan(update);
  });

  it("locks both preference tables against concurrent saves before reading them", () => {
    const sql = block.slice(block.indexOf("\nbegin;"));
    expect(sql).toMatch(/^\nbegin;\nlock table public\.user_topics, public\.user_subtopics in share row exclusive mode;\n/);
  });

  it("carries exactly the six removed topics, each mapped to an offered country", () => {
    const values = [...block.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(values)).toEqual(RETIRED);
    expect(values).toHaveLength(6);
    for (const [topic, country] of values) {
      expect(TOPICS as readonly string[], topic).not.toContain(topic);
      expect(COUNTRIES, country).toContain(country);
    }
    expect(block).toContain(`'${COUNTRIES_TOPIC}'`);
  });

  it("runs on an empty database and changes nothing", async () => {
    const before = await snapshot();
    await migrate();
    expect(await snapshot()).toEqual(before);
  });
});

describe("readers' picks", () => {
  it("gives a holder of one removed topic its country, under Countries, and drops the topic", async () => {
    const id = await user(["Tech/AI", "US Politics", "Science"]);
    await migrate();
    expect(await profile(id)).toEqual({
      topics: ["Countries", "Science", "Tech/AI"],
      countries: ["United States"],
      subtopics: [["Countries", "United States"]],
    });
  });

  it("maps each removed topic to its own country", async () => {
    for (const [topic, country] of Object.entries(RETIRED)) {
      const id = await user([topic, "Tech/AI", "Science"]);
      await migrate();
      expect((await profile(id)).countries, topic).toEqual([country]);
    }
  });

  it("gives a reader holding both topics of one country that country once", async () => {
    const us = await user(["US Politics", "US Finance", "Tech/AI"]);
    const ma = await user(["Morocco Politics", "Morocco Finance", "Football"]);
    await migrate();
    expect(await profile(us)).toMatchObject({ topics: ["Countries", "Tech/AI"], countries: ["United States"] });
    expect(await profile(ma)).toMatchObject({ topics: ["Countries", "Football"], countries: ["Morocco"] });
  });

  it("adds the country beside the countries a reader already had, and keeps one they already had once", async () => {
    const id = await user(["Countries", "French Politics", "UK Politics", "Tech/AI"], ["Germany", "France"]);
    await migrate();
    expect(await profile(id)).toMatchObject({
      topics: ["Countries", "Tech/AI"],
      countries: ["France", "Germany", "United Kingdom"],
    });
  });

  it("leaves readers without a removed topic alone, inert rows included", async () => {
    const plain = await user(["Tech/AI", "Science", "Space"]);
    const withCountries = await user(["Countries", "Geopolitics", "Africa"], ["Morocco", "Kenya"]);
    const inert = await user(["Tech/AI", "Science", "Space"], ["Italy"]);
    const before = [await profile(plain), await profile(withCountries), await profile(inert)];
    await migrate();
    expect([await profile(plain), await profile(withCountries), await profile(inert)]).toEqual(before);
  });

  it("deletes a subtopic filed under a removed topic", async () => {
    const id = await user(["US Politics", "Tech/AI", "Science"], [], [["US Politics", "Congress"]]);
    await migrate();
    expect((await profile(id)).subtopics).toEqual([["Countries", "United States"]]);
  });

  it("leaves a reader whose only picks were removed topics with Countries, so the app still sees a profile", async () => {
    const id = await user(["US Politics", "French Politics", "Morocco Finance"]);
    await migrate();
    const after = await profile(id);
    expect(after.topics).toEqual(["Countries"]);
    expect(after.countries).toEqual(["France", "Morocco", "United States"]);
    expect(unitsFor(CATALOG_AFTER, after.topics, after.countries)).toBe(3);
  });
});

describe("the 10-pick limit", () => {
  it("keeps a reader at 10 of 10 with one removed topic at exactly 10, dropping nothing else", async () => {
    const id = await user(
      ["UK Politics", "Tech/AI", "Science", "Space", "Gaming", "Music", "Countries"],
      ["Germany", "Italy", "Spain", "Japan"]
    );
    const before = await profile(id);
    expect(unitsFor(CATALOG_BEFORE, before.topics, before.countries)).toBe(10);
    await migrate();
    const after = await profile(id);
    expect(after.topics).toEqual(["Countries", "Gaming", "Music", "Science", "Space", "Tech/AI"]);
    expect(after.countries).toEqual(["Germany", "Italy", "Japan", "Spain", "United Kingdom"]);
    expect(unitsFor(CATALOG_AFTER, after.topics, after.countries)).toBe(10);
  });

  it("brings a reader holding all six down from 10 to 8: four countries for six topics", async () => {
    const id = await user([...RETIRED_TOPICS, "Tech/AI", "Science", "Space", "Gaming"]);
    await migrate();
    const after = await profile(id);
    expect(after.countries).toEqual(["France", "Morocco", "United Kingdom", "United States"]);
    expect(unitsFor(CATALOG_AFTER, after.topics, after.countries)).toBe(8);
  });

  it("deletes inert country rows of a holder without Countries, so they can't push the count past 10", async () => {
    // Without that delete this reader would come out at 12: nine topics,
    // Morocco, and the two inert rows brought back to life.
    const others = ["Tech/AI", "Science", "Space", "Gaming", "Football", "Tennis", "Music", "Books", "Travel"];
    const id = await user(["Morocco Finance", ...others], ["Germany", "Italy"]);
    expect(unitsFor(CATALOG_BEFORE, ["Morocco Finance", ...others], ["Germany", "Italy"])).toBe(10);
    await migrate();
    const after = await profile(id);
    expect(after.countries).toEqual(["Morocco"]);
    expect(unitsFor(CATALOG_AFTER, after.topics, after.countries)).toBe(10);
  });

  it("keeps a holder's real countries when they already have Countries", async () => {
    const id = await user(["Countries", "US Finance", "Tech/AI"], ["Germany", "Italy"]);
    await migrate();
    expect((await profile(id)).countries).toEqual(["Germany", "Italy", "United States"]);
  });

  it("never raises anyone's count, over 2000 random holders", async () => {
    // A seeded generator, so a failure names a reproducible profile.
    let seed = 20261014;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(list: readonly T[], n: number): T[] => [...list].sort(() => rand() - 0.5).slice(0, n);
    const pickable = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);

    const people: { id: string; units: number; retired: string[] }[] = [];
    await db.exec("begin");
    for (let i = 0; i < 2000; i++) {
      const retired = pick(RETIRED_TOPICS, 1 + Math.floor(rand() * 6));
      const topics = [...new Set([...retired, ...pick(pickable, Math.floor(rand() * 5))])];
      const countries = pick(COUNTRIES, Math.floor(rand() * 5));
      const withCountries = countries.length > 0 && rand() < 0.8;
      const saved = withCountries ? [...topics, COUNTRIES_TOPIC] : topics;
      const units = unitsFor(CATALOG_BEFORE, saved, countries);
      if (units > MAX_READING_UNITS) continue;
      // Some holders without Countries keep inert country rows.
      people.push({ id: await user(saved, withCountries || rand() < 0.5 ? countries : []), units, retired });
    }
    await db.exec("commit");
    expect(people.length).toBeGreaterThan(1000);

    await migrate();

    const topicRows = (await db.query<{ user_id: string; topic: string }>(`select user_id, topic from public.user_topics`)).rows;
    const countryRows = (await db.query<{ user_id: string; subtopic: string }>(`select user_id, subtopic from public.user_subtopics where topic = 'Countries'`)).rows;
    const byUser = <R extends { user_id: string }>(rows: R[], key: (r: R) => string) => {
      const map = new Map<string, string[]>();
      for (const r of rows) map.set(r.user_id, [...(map.get(r.user_id) ?? []), key(r)]);
      return map;
    };
    const topicsOf = byUser(topicRows, (r) => r.topic);
    const countriesOf = byUser(countryRows, (r) => r.subtopic);
    for (const person of people) {
      const topics = topicsOf.get(person.id) ?? [];
      const countries = countriesOf.get(person.id) ?? [];
      const after = unitsFor(CATALOG_AFTER, topics, countries);
      expect(after, person.id).toBeLessThanOrEqual(person.units);
      expect(after, person.id).toBeLessThanOrEqual(MAX_READING_UNITS);
      expect(topics.filter((t) => RETIRED_TOPICS.includes(t)), person.id).toEqual([]);
      for (const topic of person.retired) expect(countries, person.id).toContain(RETIRED[topic]);
      expect(topics, person.id).toContain(COUNTRIES_TOPIC);
    }
  });
});

describe("cards, bookmarks and read times", () => {
  it("refiles every removed topic's card under Countries · its country, keeping id, rank, story and bookmark", async () => {
    const id = await user(["US Politics", "Morocco Finance", "Tech/AI"]);
    const days = [await digest(id, "2026-10-01"), await digest(id, "2026-10-05"), await digest(id, "2026-10-13")];
    const cards: { id: string; topic: string }[] = [];
    for (const [i, d] of days.entries()) {
      for (const topic of [...RETIRED_TOPICS, "Tech/AI"]) cards.push({ id: await card(d, topic, { rank: i === 0 ? 1 : undefined }), topic });
    }
    const already = await card(days[2], "Countries", { subtopic: "United States" });
    const bookmarked = cards.find((c) => c.topic === "French Politics")!.id;
    await db.query(`insert into public.bookmarks (user_id, card_id) values ($1, $2)`, [id, bookmarked]);

    await migrate();

    const rows = (await db.query<{ id: string; topic: string; subtopic: string | null; front_page_rank: number | null; story_id: string; digest_id: string }>(
      `select id, topic, subtopic, front_page_rank, story_id, digest_id from public.cards`
    )).rows;
    expect(rows).toHaveLength(cards.length + 1);
    for (const c of cards) {
      const row = rows.find((r) => r.id === c.id)!;
      if (c.topic === "Tech/AI") expect(row).toMatchObject({ topic: "Tech/AI", subtopic: null });
      else expect(row, c.topic).toMatchObject({ topic: "Countries", subtopic: RETIRED[c.topic] });
      expect(row.story_id).toBe(c.id);
    }
    expect(rows.filter((r) => r.front_page_rank === 1)).toHaveLength(7);
    expect(new Set(rows.map((r) => r.digest_id))).toEqual(new Set(days));
    expect(rows.find((r) => r.id === already)).toMatchObject({ topic: "Countries", subtopic: "United States" });
    expect((await db.query(`select 1 from public.cards where topic = any($1)`, [RETIRED_TOPICS])).rows).toEqual([]);
    expect((await db.query(`select card_id from public.bookmarks`)).rows).toEqual([{ card_id: bookmarked }]);
    expect(rows.find((r) => r.id === bookmarked)).toMatchObject({ topic: "Countries", subtopic: "France" });
  });

  it("deletes removed topics' read times and keeps every other one, an existing country's included", async () => {
    const id = await user(["Countries", "UK Politics", "Tech/AI"], ["United States"]);
    const t = "2026-10-13T08:00:00Z";
    for (const [topic, subtopic] of [["UK Politics", ""], ["US Politics", ""], ["Tech/AI", ""], ["Countries", "United States"]])
      await db.query(`insert into public.unit_read_cursors (user_id, topic, subtopic, read_at) values ($1, $2, $3, $4)`, [id, topic, subtopic, t]);
    await migrate();
    const cursors = (await db.query<{ topic: string; subtopic: string }>(`select topic, subtopic from public.unit_read_cursors order by topic, subtopic`)).rows;
    // No row for the United Kingdom: the new unit reads the full lookback once.
    expect(cursors).toEqual([
      { topic: "Countries", subtopic: "United States" },
      { topic: "Tech/AI", subtopic: "" },
    ]);
  });
});

describe("running it again", () => {
  it("changes nothing on a second and third run", async () => {
    const a = await user(["US Politics", "US Finance", "Tech/AI"]);
    await user(["Countries", "French Politics", "Science"], ["France"]);
    await user(["Morocco Politics", "Gaming", "Music"], ["Italy"]);
    const d = await digest(a, "2026-10-10");
    await card(d, "US Politics");
    await card(d, "US Finance", { rank: 2 });
    await migrate();
    const once = await snapshot();
    await migrate();
    expect(await snapshot()).toEqual(once);
    await migrate();
    expect(await snapshot()).toEqual(once);
  });

  it("moves a reader who picked a removed topic again between the two runs", async () => {
    const id = await user(["Countries", "UK Politics", "Tech/AI"], ["Germany"]);
    await migrate();
    // The old code, still deployed, saves a removed topic beside the migrated set.
    await db.query(`insert into public.user_topics (user_id, topic) values ($1, 'French Politics')`, [id]);
    await migrate();
    expect(await profile(id)).toMatchObject({
      topics: ["Countries", "Tech/AI"],
      countries: ["France", "Germany", "United Kingdom"],
    });
  });

  it("rolls everything back when a statement fails part-way", async () => {
    const id = await user(["US Politics", "Tech/AI", "Science"]);
    const d = await digest(id, "2026-10-10");
    await card(d, "US Politics");
    // The cursor delete is the last statement, so dropping its table makes
    // the block fail with every other change, the card refile included, done.
    await db.exec(`drop table public.unit_read_cursors`);
    await expect(migrate()).rejects.toThrow(/unit_read_cursors/);
    await db.exec("rollback");
    expect((await db.query(`select topic from public.user_topics where user_id = $1 order by topic`, [id])).rows).toEqual([
      { topic: "Science" },
      { topic: "Tech/AI" },
      { topic: "US Politics" },
    ]);
    expect((await db.query(`select 1 from public.user_subtopics`)).rows).toEqual([]);
    expect((await db.query(`select topic from public.cards`)).rows).toEqual([{ topic: "US Politics" }]);
  });
});
