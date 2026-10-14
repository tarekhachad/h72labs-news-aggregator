import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { TOPICS } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countryNames";
import { MAX_READING_UNITS, countReadingUnits } from "@/lib/readingUnits";

// Round-3 QA: the reordered V2.7 block (card refile before the read-time
// delete) on the WHOLE production schema, over a seeded, deterministic
// population, checked against an independent reference model.

type PG = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const schema = readFileSync(path.resolve(__dirname, "../../supabase/schema.sql"), "utf8");
const MARKER = "-- V2.7 migration: the six single-country topics become their countries.";
const block = schema.slice(schema.indexOf(MARKER));

const RETIRED: Record<string, string> = {
  "US Politics": "United States",
  "US Finance": "United States",
  "UK Politics": "United Kingdom",
  "French Politics": "France",
  "Morocco Politics": "Morocco",
  "Morocco Finance": "Morocco",
};
const RETIRED_TOPICS = Object.keys(RETIRED);
const CATALOG_AFTER: readonly string[] = TOPICS;
const CATALOG_BEFORE: readonly string[] = [...TOPICS, ...RETIRED_TOPICS];
const OTHERS = ["Tech/AI", "Science", "Space", "Gaming", "Football", "Economy", "Crypto", "Banking", "Geopolitics", "Elections"];
const COUNTRY_POOL = ["United States", "United Kingdom", "France", "Morocco", "Germany", "Japan"];

function unitsFor(catalog: readonly string[], topics: string[], countries: string[]): number {
  const known = topics.filter((t) => catalog.includes(t));
  return countReadingUnits(known, known.includes(COUNTRIES_TOPIC) ? countries : []);
}

// Deterministic PRNG + uuids so a failure is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

let db: PG;

async function freshDb(): Promise<PG> {
  const pg = new PGlite() as unknown as PG;
  await pg.exec(`
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
  await pg.exec(schema);
  return pg;
}

type Profile = { topics: string[]; countries: string[]; other: [string, string][] };

type Seeded = {
  users: Map<string, Profile>;
};

async function seed(n: number, seedValue: number): Promise<Seeded> {
  const r = rng(seedValue);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const users = new Map<string, Profile>();
  const values: { topics: string[]; subs: string[]; cursors: string[]; digests: string[]; cards: string[]; bookmarks: string[]; usersSql: string[] } = {
    topics: [], subs: [], cursors: [], digests: [], cards: [], bookmarks: [], usersSql: [],
  };
  for (let i = 0; i < n; i++) {
    const id = uuid();
    values.usersSql.push(`('${id}')`);
    const topics = new Set<string>();
    const nRetired = Math.floor(r() * 4); // 0..3
    for (let k = 0; k < nRetired; k++) topics.add(pick(RETIRED_TOPICS));
    if (r() < 0.5) topics.add(COUNTRIES_TOPIC);
    const nOthers = Math.floor(r() * 9);
    for (let k = 0; k < nOthers; k++) topics.add(pick(OTHERS));
    const countries = new Set<string>();
    // Countries rows present with or without the topic (inert when without).
    const nCountries = Math.floor(r() * 4);
    for (let k = 0; k < nCountries; k++) countries.add(pick(COUNTRY_POOL));
    // Trim to the old catalog's limit, the way the old picker would have.
    const topicList = [...topics];
    const countryList = [...countries];
    while (unitsFor(CATALOG_BEFORE, topicList, countryList) > MAX_READING_UNITS) {
      if (countryList.length > 0 && topicList.includes(COUNTRIES_TOPIC) && r() < 0.5) countryList.pop();
      else topicList.splice(topicList.length - 1, 1);
    }
    const other: [string, string][] = [];
    if (r() < 0.15) other.push(["Football", "Arsenal"]);
    if (r() < 0.15 && topicList.some((t) => RETIRED_TOPICS.includes(t))) {
      other.push([topicList.find((t) => RETIRED_TOPICS.includes(t)) as string, "stray"]);
    }
    users.set(id, { topics: topicList, countries: countryList, other });
    for (const t of topicList) values.topics.push(`('${id}', '${t}')`);
    for (const c of countryList) values.subs.push(`('${id}', 'Countries', '${c}')`);
    for (const [t, s] of other) values.subs.push(`('${id}', '${t}', '${s}')`);
    // Read times: every topic unit, plus some countries, plus a stale retired one.
    let minute = 0;
    for (const t of topicList.filter((t) => t !== COUNTRIES_TOPIC)) values.cursors.push(`('${id}', '${t}', '', '2026-10-10T00:${String(minute++ % 60).padStart(2, "0")}:00Z')`);
    for (const c of countryList) if (r() < 0.6) values.cursors.push(`('${id}', 'Countries', '${c}', '2026-10-09T05:${String(minute++ % 60).padStart(2, "0")}:00Z')`);
    if (r() < 0.2) {
      const stale = pick(RETIRED_TOPICS);
      if (!topicList.includes(stale)) values.cursors.push(`('${id}', '${stale}', '', '2026-09-01T00:00:00Z')`);
    }
    // Two digests, cards across all of this user's units plus a retired one they dropped.
    for (const date of ["2026-10-09", "2026-10-10"]) {
      const d = uuid();
      values.digests.push(`('${d}', '${id}', '${date}')`);
      const cardTopics = [...topicList.filter((t) => t !== COUNTRIES_TOPIC), pick(RETIRED_TOPICS)];
      let rank = 1;
      for (const t of cardTopics) {
        const c = uuid();
        const story = r() < 0.3 ? `'00000000-0000-4000-9000-${String(i).padStart(12, "0")}'` : `'${c}'`;
        const rk = r() < 0.4 && rank <= 6 ? String(rank++) : "null";
        const emb = r() < 0.3 ? `array_fill(0.25::real, array[384])` : "null";
        values.cards.push(`('${c}', '${d}', '${t}', null, 's ${c}', '[]', '2026-10-09T00:00:00Z', ${rk}, ${story}, ${emb}, 2)`);
        if (r() < 0.3) values.bookmarks.push(`('${id}', '${c}')`);
      }
      for (const country of countryList) {
        const c = uuid();
        values.cards.push(`('${c}', '${d}', 'Countries', '${country}', 's ${c}', '[]', '2026-10-09T00:00:00Z', null, '${c}', null, 3)`);
      }
    }
  }
  const ins = async (sql: string, rows: string[]) => {
    for (let i = 0; i < rows.length; i += 500) await db.exec(`${sql} ${rows.slice(i, i + 500).join(",")};`);
  };
  await ins(`insert into auth.users (id) values`, values.usersSql);
  await ins(`insert into public.user_topics (user_id, topic) values`, values.topics);
  await ins(`insert into public.user_subtopics (user_id, topic, subtopic) values`, values.subs);
  await ins(`insert into public.unit_read_cursors (user_id, topic, subtopic, read_at) values`, values.cursors);
  await ins(`insert into public.digests (id, user_id, date) values`, values.digests);
  await ins(
    `insert into public.cards (id, digest_id, topic, subtopic, short_summary, sources, published_at, front_page_rank, story_id, embedding, severity) values`,
    values.cards
  );
  await ins(`insert into public.bookmarks (user_id, card_id) values`, values.bookmarks);
  return { users };
}

type Snap = {
  topics: { user_id: string; topic: string }[];
  subtopics: { user_id: string; topic: string; subtopic: string }[];
  cursors: { user_id: string; topic: string; subtopic: string; read_at: unknown }[];
  cards: { id: string; digest_id: string; topic: string; subtopic: string | null; front_page_rank: number | null; story_id: string; emb: string | null; created_at: unknown; short_summary: string; severity: number }[];
  bookmarks: { user_id: string; card_id: string }[];
  digests: { id: string; user_id: string; date: unknown }[];
};

async function snapshot(): Promise<Snap> {
  const q = async <T,>(sql: string) => (await db.query<T>(sql)).rows;
  return {
    topics: await q(`select user_id, topic from public.user_topics order by 1, 2`),
    subtopics: await q(`select user_id, topic, subtopic from public.user_subtopics order by 1, 2, 3`),
    cursors: await q(`select user_id, topic, subtopic, read_at from public.unit_read_cursors order by 1, 2, 3`),
    cards: await q(`select id, digest_id, topic, subtopic, front_page_rank, story_id, md5(embedding::text) as emb, created_at, short_summary, severity from public.cards order by 1`),
    bookmarks: await q(`select user_id, card_id from public.bookmarks order by 1, 2`),
    digests: await q(`select id, user_id, date from public.digests order by 1`),
  };
}

/** The reference model: what each reader's profile must be after the block. */
function expected(p: Profile): { topics: string[]; subs: [string, string][] } {
  const retiredHeld = p.topics.filter((t) => RETIRED_TOPICS.includes(t));
  if (retiredHeld.length === 0) {
    return {
      topics: [...p.topics].sort(),
      subs: [...p.countries.map((c) => ["Countries", c] as [string, string]), ...p.other].sort(cmpPair),
    };
  }
  const hadCountries = p.topics.includes(COUNTRIES_TOPIC);
  const topics = [...new Set([...p.topics.filter((t) => !RETIRED_TOPICS.includes(t)), COUNTRIES_TOPIC])].sort();
  const countries = new Set(hadCountries ? p.countries : []);
  for (const t of retiredHeld) countries.add(RETIRED[t]);
  const other = p.other.filter(([t]) => !RETIRED_TOPICS.includes(t));
  return { topics, subs: [...[...countries].map((c) => ["Countries", c] as [string, string]), ...other].sort(cmpPair) };
}
function cmpPair(a: [string, string], b: [string, string]) {
  return a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1;
}

function checkAfter(seeded: Seeded, before: Snap, after: Snap) {
  // Profiles: exact match with the reference model, and the at-limit rule.
  for (const [id, p] of seeded.users) {
    const exp = expected(p);
    const topics = after.topics.filter((r) => r.user_id === id).map((r) => r.topic).sort();
    const subs = after.subtopics.filter((r) => r.user_id === id).map((r) => [r.topic, r.subtopic] as [string, string]).sort(cmpPair);
    expect(topics, id).toEqual(exp.topics);
    expect(subs, id).toEqual(exp.subs);
    const countries = subs.filter(([t]) => t === COUNTRIES_TOPIC).map(([, c]) => c);
    const was = unitsFor(CATALOG_BEFORE, p.topics, p.countries);
    const isNew = unitsFor(CATALOG_AFTER, topics, countries);
    const isOld = unitsFor(CATALOG_BEFORE, topics, countries);
    expect(isNew, `${id} new-code count`).toBeLessThanOrEqual(was);
    expect(isOld, `${id} old-code count`).toBeLessThanOrEqual(was);
    expect(isNew).toBeLessThanOrEqual(MAX_READING_UNITS);
    // Old-code validity: every topic is in the old catalog, every country offered.
    for (const t of topics) expect(CATALOG_BEFORE).toContain(t);
    for (const c of countries) expect(COUNTRIES).toContain(c);
  }
  // No retired name anywhere it could be read.
  for (const r of after.topics) expect(RETIRED_TOPICS).not.toContain(r.topic);
  for (const r of after.subtopics) expect(RETIRED_TOPICS).not.toContain(r.topic);
  for (const r of after.cursors) expect(RETIRED_TOPICS).not.toContain(r.topic);
  for (const r of after.cards) expect(RETIRED_TOPICS).not.toContain(r.topic);
  // Cards: same ids, each field kept; retired ones refiled to their country.
  expect(after.cards.map((c) => c.id)).toEqual(before.cards.map((c) => c.id));
  after.cards.forEach((c, i) => {
    const b = before.cards[i];
    const { topic: bt, subtopic: bs, ...bRest } = b;
    const { topic: at, subtopic: as, ...aRest } = c;
    expect(aRest).toEqual(bRest);
    if (RETIRED_TOPICS.includes(bt)) {
      expect([at, as]).toEqual([COUNTRIES_TOPIC, RETIRED[bt]]);
    } else {
      expect([at, as]).toEqual([bt, bs]);
    }
  });
  expect(after.bookmarks).toEqual(before.bookmarks);
  expect(after.digests).toEqual(before.digests);
  // Cursors: exactly the non-retired ones, unchanged.
  expect(after.cursors).toEqual(before.cursors.filter((c) => !RETIRED_TOPICS.includes(c.topic)));
}

const migrate = () => db.exec(block);

// The block as psql or a statement-at-a-time runner sends it: one statement
// per round trip, so only its own begin/commit make it one transaction (a
// multi-statement exec is an implicit transaction of its own and would hide
// a missing begin).
const statements = block
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n")
  .split(/;\s*\n/)
  .map((s) => s.trim().replace(/;$/, ""))
  .filter((s) => s.length > 0);
async function migrateOneByOne(): Promise<void> {
  for (const sql of statements) await db.exec(sql);
}

beforeEach(async () => {
  db = await freshDb();
  uuidCounter = 0;
});

describe("r3: the reordered block over a seeded population", () => {
  it("matches the reference model for 600 readers, keeps cards/bookmarks/ranks/stories/cursors, and is idempotent", async () => {
    const seeded = await seed(600, 1234);
    const before = await snapshot();
    // Sanity: the seed actually exercises the interesting cases.
    const atLimitHolders = [...seeded.users.values()].filter(
      (p) => p.topics.some((t) => RETIRED_TOPICS.includes(t)) && unitsFor(CATALOG_BEFORE, p.topics, p.countries) === MAX_READING_UNITS
    ).length;
    const inertHolders = [...seeded.users.values()].filter(
      (p) => p.topics.some((t) => RETIRED_TOPICS.includes(t)) && !p.topics.includes(COUNTRIES_TOPIC) && p.countries.length > 0
    ).length;
    expect(atLimitHolders).toBeGreaterThan(10);
    expect(inertHolders).toBeGreaterThan(10);
    expect(before.cards.filter((c) => RETIRED_TOPICS.includes(c.topic)).length).toBeGreaterThan(500);

    await migrate();
    const after = await snapshot();
    checkAfter(seeded, before, after);

    await migrate();
    expect(await snapshot()).toEqual(after);
    await migrate();
    expect(await snapshot()).toEqual(after);
  }, 120_000);

  it("a SQL count of each reader's units agrees with countReadingUnits, so it can find an over-limit reader after the second pass", async () => {
    const seeded = await seed(300, 77);
    await migrate();
    // One reader pushed over the limit, the way a save interleaving with the block could.
    const [victim] = [...seeded.users.keys()];
    await db.query(`insert into public.user_topics (user_id, topic) select $1, t from unnest($2::text[]) t on conflict do nothing`, [victim, OTHERS]);
    await db.query(`insert into public.user_topics (user_id, topic) values ($1, 'Countries') on conflict do nothing`, [victim]);
    await db.query(`insert into public.user_subtopics (user_id, topic, subtopic) select $1, 'Countries', c from unnest($2::text[]) c on conflict do nothing`, [victim, COUNTRY_POOL]);
    const sql = `
      select t.user_id,
             count(*) filter (where t.topic <> 'Countries')
             + case when bool_or(t.topic = 'Countries')
                    then (select count(distinct s.subtopic) from public.user_subtopics s where s.user_id = t.user_id and s.topic = 'Countries')
                    else 0 end as units
      from public.user_topics t
      group by t.user_id`;
    const rows = (await db.query<{ user_id: string; units: number }>(sql)).rows;
    const snap = await snapshot();
    for (const r of rows) {
      const topics = snap.topics.filter((x) => x.user_id === r.user_id).map((x) => x.topic);
      const countries = snap.subtopics.filter((x) => x.user_id === r.user_id && x.topic === COUNTRIES_TOPIC).map((x) => x.subtopic);
      expect(Number(r.units), r.user_id).toBe(unitsFor(CATALOG_AFTER, topics, countries));
    }
    const over = rows.filter((r) => Number(r.units) > MAX_READING_UNITS).map((r) => r.user_id);
    expect(over).toEqual([victim]);
  }, 60_000);
});

describe("r3: a failure at each later statement rolls the whole block back", () => {
  it("splits into begin, the lock, the work and commit", () => {
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toMatch(/^lock table public\.user_topics, public\.user_subtopics in share row exclusive mode$/);
    expect(statements[statements.length - 1]).toBe("commit");
    expect(statements[statements.length - 2]).toMatch(/^delete from public\.unit_read_cursors/);
    expect(statements[statements.length - 3]).toMatch(/^update public\.cards c/);
  });

  const failures: [string, string][] = [
    ["the topic-row delete (middle)", "before delete on public.user_topics"],
    ["the subtopic delete (middle)", "before delete on public.user_subtopics"],
    ["the card refile (now second-to-last)", "before update on public.cards"],
    ["the read-time delete (now last)", "before delete on public.unit_read_cursors"],
    ["the country insert (middle)", "before insert on public.user_subtopics"],
  ];
  for (const [label, on] of failures) {
    it(`at ${label}`, async () => {
      const seeded = await seed(40, 99);
      const before = await snapshot();
      await db.exec(`
        create function public.qa_boom() returns trigger language plpgsql as $$ begin raise exception 'qa boom'; end $$;
        create trigger qa_boom ${on} for each row execute function public.qa_boom();
      `);
      await expect(migrateOneByOne()).rejects.toThrow(/qa boom/);
      await db.exec("rollback");
      expect(await snapshot()).toEqual(before);
      // No lock outlives the failed transaction.
      const locks = await db.query(`select 1 from pg_locks l join pg_class c on c.oid = l.relation where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'`);
      expect(locks.rows).toEqual([]);
      await db.exec(`drop trigger qa_boom on ${on.split(" on ")[1]}; drop function public.qa_boom();`);
      await migrateOneByOne();
      checkAfter(seeded, before, await snapshot());
    }, 60_000);
  }
});

describe("r3: old-code persist_generated_cards around the block", () => {
  async function asUser(id: string) {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id]);
  }
  async function persist(digestId: string, cards: object[], rankUpdates: object[], units: object[]) {
    await db.query(`select public.persist_generated_cards($1::uuid, $2::jsonb, now(), $3::jsonb, $4::jsonb)`, [
      digestId,
      JSON.stringify(cards),
      JSON.stringify(rankUpdates),
      JSON.stringify(units),
    ]);
  }
  const oldCard = (id: string, topic: string, rank: number | null) => ({
    id, topic, title: "t", shortSummary: "s", labels: [], sources: [], publishedAt: "2026-10-10T00:00:00Z", severity: 2, frontPageRank: rank,
  });

  it("a save before the block, a save between the passes and the second pass end with every card refiled and no retired read time", async () => {
    const id = uuid();
    await db.query(`insert into auth.users (id) values ($1)`, [id]);
    await db.query(`insert into public.user_topics (user_id, topic) values ($1, 'US Politics'), ($1, 'Science'), ($1, 'Space')`, [id]);
    const d = uuid();
    await db.query(`insert into public.digests (id, user_id, date) values ($1, $2, current_date)`, [d, id]);
    await asUser(id);

    // Old code, before pass 1: a US Politics card and read time.
    const c1 = uuid();
    await persist(d, [oldCard(c1, "US Politics", 1)], [], [{ topic: "US Politics" }, { topic: "Science" }]);
    expect((await db.query(`select topic from public.unit_read_cursors where user_id = $1 order by 1`, [id])).rows).toEqual([{ topic: "Science" }, { topic: "US Politics" }]);
    await db.query(`insert into public.bookmarks (user_id, card_id) values ($1, $2)`, [id, c1]);

    await migrate();
    expect((await db.query(`select topic, subtopic, front_page_rank, story_id from public.cards where id = $1`, [c1])).rows).toEqual([
      { topic: "Countries", subtopic: "United States", front_page_rank: 1, story_id: c1 },
    ]);
    expect((await db.query(`select topic from public.unit_read_cursors where user_id = $1 order by 1`, [id])).rows).toEqual([{ topic: "Science" }]);

    // Old code, a run that started before pass 1 saves after it: its new card
    // is still US Politics, it re-ranks the refiled card, and the US Politics
    // read time is skipped (the reader no longer holds the topic).
    const c2 = uuid();
    await persist(d, [oldCard(c2, "US Politics", 1)], [{ id: c1, frontPageRank: 2 }], [{ topic: "US Politics" }, { topic: "Countries", subtopic: "United States" }]);
    expect((await db.query(`select id, topic, front_page_rank from public.cards order by front_page_rank`)).rows).toEqual([
      { id: c2, topic: "US Politics", front_page_rank: 1 },
      { id: c1, topic: "Countries", front_page_rank: 2 },
    ]);
    expect((await db.query(`select topic, subtopic from public.unit_read_cursors where user_id = $1 order by 1, 2`, [id])).rows).toEqual([
      { topic: "Countries", subtopic: "United States" },
      { topic: "Science", subtopic: "" },
    ]);

    // Second pass.
    await migrate();
    expect((await db.query(`select id, topic, subtopic, front_page_rank from public.cards order by front_page_rank`)).rows).toEqual([
      { id: c2, topic: "Countries", subtopic: "United States", front_page_rank: 1 },
      { id: c1, topic: "Countries", subtopic: "United States", front_page_rank: 2 },
    ]);
    expect((await db.query(`select card_id from public.bookmarks`)).rows).toEqual([{ card_id: c1 }]);
    expect((await db.query(`select topic from public.user_topics where user_id = $1 order by 1`, [id])).rows).toEqual([
      { topic: "Countries" }, { topic: "Science" }, { topic: "Space" },
    ]);
  });
});
