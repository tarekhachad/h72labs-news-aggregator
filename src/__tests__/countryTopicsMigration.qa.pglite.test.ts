import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";
import { TOPICS } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countryNames";
import { MAX_READING_UNITS, countReadingUnits } from "@/lib/readingUnits";
import { getUserProfile } from "@/lib/profile";

// Independent QA of the V2.7 single-country-topic migration. Unlike the
// lane's own test, this loads the WHOLE of supabase/schema.sql (so every
// table, constraint, policy and function production has is present, and the
// block itself already ran once on an empty database as the file's last
// statement), then runs the block against an exhaustive grid of profiles.

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
const OTHERS = ["Tech/AI", "Science", "Space", "Gaming", "Football", "Tennis", "Music", "Books", "Travel"];
const COUNTRY_POOL = ["United States", "United Kingdom", "France", "Morocco", "Germany"];

/** The units getUserProfile + countReadingUnits give for stored rows, under a catalog. */
function unitsFor(catalog: readonly string[], topics: string[], countries: string[]): number {
  const known = topics.filter((t) => catalog.includes(t));
  return countReadingUnits(known, known.includes(COUNTRIES_TOPIC) ? countries.filter((c) => COUNTRIES.includes(c)) : []);
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

async function snapshot(): Promise<unknown> {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    topics: await q(`select user_id, topic from public.user_topics order by 1, 2`),
    subtopics: await q(`select user_id, topic, subtopic from public.user_subtopics order by 1, 2, 3`),
    sources: await q(`select user_id, source from public.user_preferred_sources order by 1, 2`),
    cursors: await q(`select user_id, topic, subtopic, read_at from public.unit_read_cursors order by 1, 2, 3`),
    cards: await q(`select id, digest_id, topic, subtopic, front_page_rank, story_id, embedding from public.cards order by 1`),
    bookmarks: await q(`select user_id, card_id from public.bookmarks order by 1, 2`),
    digests: await q(`select id, user_id, date, last_generated_at from public.digests order by 1`),
  };
}

const migrate = () => db.exec(block);

/** A supabase-js look-alike over PGlite, enough for getUserProfile's reads. */
function fakeSupabase(): SupabaseClient {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let cols = "*";
    const run = async () => {
      const where = filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
      try {
        const { rows } = await db.query(`select ${cols} from public.${table}${where ? ` where ${where}` : ""}`, filters.map(([, v]) => v));
        return { data: rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    };
    const builder = {
      select(c: string) {
        cols = c;
        return builder;
      },
      eq(c: string, v: unknown) {
        filters.push([c, v]);
        return builder;
      },
      async maybeSingle() {
        const r = await run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        return run().then(resolve, reject);
      },
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

beforeEach(async () => {
  db = await freshDb();
});

describe("on the full production schema", () => {
  it("the whole of schema.sql (block included, last) runs on an empty database", async () => {
    // freshDb ran it; the block left nothing behind and the temp table is gone.
    expect((await db.query(`select count(*)::int as n from public.user_topics`)).rows).toEqual([{ n: 0 }]);
    expect((await db.query(`select to_regclass('retired_country_topics') as t`)).rows).toEqual([{ t: null }]);
    await migrate();
    await migrate();
  });
});

describe("every combination of retired topics, Countries, countries and fill", () => {
  it("lands each reader exactly where the at-limit rule says, never above their old count or 10", async () => {
    type Person = { id: string; R: string[]; hasC: boolean; C: string[]; others: string[]; before: number; orphan: boolean };
    const people: Person[] = [];
    for (let r = 1; r < 64; r++) {
      const R = RETIRED_TOPICS.filter((_, i) => r & (1 << i));
      for (const hasC of [false, true]) {
        for (let cm = 0; cm < 32; cm++) {
          const C = COUNTRY_POOL.filter((_, i) => cm & (1 << i));
          const base = R.length + (hasC ? C.length : 0);
          const kmax = Math.min(OTHERS.length, MAX_READING_UNITS - base);
          if (kmax < 0) continue;
          for (const k of new Set([0, kmax])) {
            const others = OTHERS.slice(0, k);
            const topics = [...R, ...others, ...(hasC ? [COUNTRIES_TOPIC] : [])];
            const before = unitsFor(CATALOG_BEFORE, topics, C);
            people.push({ id: randomUUID(), R, hasC, C, others, before, orphan: cm % 3 === 0 });
          }
        }
      }
    }
    expect(people.length).toBeGreaterThan(4000);

    const ids = people.map((p) => p.id);
    const tU: string[] = [], tT: string[] = [], sU: string[] = [], sT: string[] = [], sS: string[] = [];
    const cU: string[] = [], cT: string[] = [], cS: string[] = [];
    for (const p of people) {
      for (const t of [...p.R, ...p.others, ...(p.hasC ? [COUNTRIES_TOPIC] : [])]) {
        tU.push(p.id);
        tT.push(t);
        cU.push(p.id);
        cT.push(t);
        cS.push("");
      }
      for (const c of p.C) {
        sU.push(p.id);
        sT.push(COUNTRIES_TOPIC);
        sS.push(c);
        if (p.hasC) {
          cU.push(p.id);
          cT.push(COUNTRIES_TOPIC);
          cS.push(c);
        }
      }
      if (p.orphan) {
        sU.push(p.id);
        sT.push(p.R[0]);
        sS.push("Something");
      }
    }
    await db.query(`insert into auth.users (id) select unnest($1::uuid[])`, [ids]);
    await db.query(`insert into public.user_topics (user_id, topic) select * from unnest($1::uuid[], $2::text[])`, [tU, tT]);
    await db.query(`insert into public.user_subtopics (user_id, topic, subtopic) select * from unnest($1::uuid[], $2::text[], $3::text[])`, [sU, sT, sS]);
    await db.query(
      `insert into public.unit_read_cursors (user_id, topic, subtopic, read_at) select u, t, s, now() - interval '1 hour' from unnest($1::uuid[], $2::text[], $3::text[]) as x(u, t, s)`,
      [cU, cT, cS]
    );

    await migrate();
    const once = await snapshot();
    await migrate();
    expect(await snapshot()).toEqual(once);

    const group = async (sql: string) => {
      const m = new Map<string, string[]>();
      for (const r of (await db.query<{ u: string; v: string }>(sql)).rows) m.set(r.u, [...(m.get(r.u) ?? []), r.v]);
      return m;
    };
    const topicsOf = await group(`select user_id as u, topic as v from public.user_topics`);
    const countriesOf = await group(`select user_id as u, subtopic as v from public.user_subtopics where topic = 'Countries'`);
    const otherSubsOf = await group(`select user_id as u, topic as v from public.user_subtopics where topic <> 'Countries'`);
    const cursorsOf = await group(`select user_id as u, topic || '/' || subtopic as v from public.unit_read_cursors`);

    let fellBelow3 = 0;
    let atTenBefore = 0;
    for (const p of people) {
      const topics = (topicsOf.get(p.id) ?? []).sort();
      const countries = (countriesOf.get(p.id) ?? []).sort();
      const after = unitsFor(CATALOG_AFTER, topics, countries);
      const label = JSON.stringify({ R: p.R, hasC: p.hasC, C: p.C, k: p.others.length });

      const kept = p.hasC ? p.C : [];
      const expectedCountries = [...new Set([...kept, ...p.R.map((t) => RETIRED[t])])].sort();
      expect(topics, label).toEqual([...p.others, COUNTRIES_TOPIC].sort());
      expect(countries, label).toEqual(expectedCountries);
      expect(otherSubsOf.get(p.id), label).toBeUndefined();
      expect(after, label).toBe(p.others.length + expectedCountries.length);
      expect(after, label).toBeLessThanOrEqual(p.before);
      expect(after, label).toBeLessThanOrEqual(MAX_READING_UNITS);
      // Valid under the OLD code too (deployed while the first run happens).
      for (const t of topics) expect(CATALOG_BEFORE, label).toContain(t);
      for (const c of countries) expect(COUNTRIES, label).toContain(c);
      expect(unitsFor(CATALOG_BEFORE, topics, countries), label).toBe(after);
      // Cursors: every retired topic's gone; every other one kept.
      const cursors = (cursorsOf.get(p.id) ?? []).sort();
      expect(cursors.filter((c) => RETIRED_TOPICS.includes(c.split("/")[0])), label).toEqual([]);
      expect(cursors, label).toEqual([...p.others.map((t) => `${t}/`), ...kept.map((c) => `Countries/${c}`), ...(p.hasC ? ["Countries/"] : [])].sort());
      if (after < 3) fellBelow3++;
      if (p.before === 10) atTenBefore++;
    }
    expect(atTenBefore).toBeGreaterThan(1000);
    expect(fellBelow3).toBeGreaterThan(0);
  }, 120_000);
});

describe("cards over several days", () => {
  it("refiles every retired card in place, keeping id, digest, rank, story, embedding and bookmark, and touching no other row", async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    await db.query(`insert into auth.users (id) values ($1), ($2)`, [alice, bob]);
    await db.query(`insert into public.user_topics (user_id, topic) values ($1, 'US Finance'), ($1, 'Tech/AI'), ($1, 'Science'), ($2, 'Tech/AI'), ($2, 'Science'), ($2, 'Space')`, [alice, bob]);
    const days = ["2026-10-01", "2026-10-07", "2026-10-13"];
    const emb = `{${Array.from({ length: 384 }, (_, i) => (i % 7) / 100).join(",")}}`;
    const expected: Record<string, { topic: string; subtopic: string | null; rank: number | null; story: string; digest: string }> = {};
    const story = randomUUID();
    for (const [i, day] of days.entries()) {
      for (const user of [alice, bob]) {
        const d = (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date, last_generated_at) values (gen_random_uuid(), $1, $2, now()) returning id`, [user, day])).rows[0].id;
        const topics = [...RETIRED_TOPICS, "Tech/AI", COUNTRIES_TOPIC];
        for (const [j, topic] of topics.entries()) {
          const id = randomUUID();
          const subtopic = topic === COUNTRIES_TOPIC ? "Germany" : null;
          const rank = j < 6 && i === 2 ? j + 1 : null;
          const storyId = topic === "US Finance" ? story : id;
          await db.query(
            `insert into public.cards (id, digest_id, topic, subtopic, short_summary, sources, published_at, front_page_rank, story_id, embedding, title)
             values ($1, $2, $3, $4, 's', '[]', now(), $5, $6, $7::real[], 't')`,
            [id, d, topic, subtopic, rank, storyId, emb]
          );
          await db.query(`insert into public.bookmarks (user_id, card_id) values ($1, $2)`, [user, id]);
          expected[id] = {
            topic: RETIRED[topic] ? COUNTRIES_TOPIC : topic,
            subtopic: RETIRED[topic] ?? subtopic,
            rank,
            story: storyId,
            digest: d,
          };
        }
      }
    }
    const before = (await snapshot()) as { bookmarks: unknown; digests: unknown; cards: { id: string; embedding: unknown }[] };

    await migrate();

    const after = (await snapshot()) as typeof before;
    expect(after.bookmarks).toEqual(before.bookmarks);
    expect(after.digests).toEqual(before.digests);
    const rows = (await db.query<{ id: string; topic: string; subtopic: string | null; front_page_rank: number | null; story_id: string; digest_id: string }>(
      `select id, topic, subtopic, front_page_rank, story_id, digest_id from public.cards`
    )).rows;
    expect(rows).toHaveLength(Object.keys(expected).length);
    for (const r of rows) {
      const e = expected[r.id];
      expect({ topic: r.topic, subtopic: r.subtopic, rank: r.front_page_rank, story: r.story_id, digest: r.digest_id }).toEqual(e);
    }
    // Embeddings untouched.
    expect(after.cards.map((c) => c.embedding)).toEqual(before.cards.map((c) => c.embedding));
    // Bob held no retired topic: his profile is untouched, but his retired cards move too.
    expect((await db.query(`select topic from public.user_topics where user_id = $1 order by 1`, [bob])).rows.map((r) => (r as { topic: string }).topic)).toEqual(["Science", "Space", "Tech/AI"]);
  });
});

describe("a failure part-way", () => {
  async function seed() {
    const id = randomUUID();
    await db.query(`insert into auth.users (id) values ($1)`, [id]);
    await db.query(`insert into public.user_topics (user_id, topic) values ($1, 'UK Politics'), ($1, 'Tech/AI'), ($1, 'Science')`, [id]);
    await db.query(`insert into public.user_subtopics (user_id, topic, subtopic) values ($1, 'Countries', 'Italy')`, [id]);
    await db.query(`insert into public.unit_read_cursors (user_id, topic, subtopic, read_at) values ($1, 'UK Politics', '', now())`, [id]);
    const d = (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date) values (gen_random_uuid(), $1, '2026-10-10') returning id`, [id])).rows[0].id;
    await db.query(`insert into public.cards (id, digest_id, topic, short_summary, sources, published_at) values (gen_random_uuid(), $1, 'UK Politics', 's', '[]', now())`, [d]);
  }

  it("at the card refile, second to last, rolls back every earlier delete and insert, and a rerun then succeeds", async () => {
    await seed();
    const before = await snapshot();
    await db.exec(`
      create function public.qa_boom() returns trigger language plpgsql as $$ begin raise exception 'qa boom'; end $$;
      create trigger qa_boom before update on public.cards for each row execute function public.qa_boom();
    `);
    await expect(migrate()).rejects.toThrow(/qa boom/);
    await db.exec("rollback");
    expect(await snapshot()).toEqual(before);
    await db.exec(`drop trigger qa_boom on public.cards; drop function public.qa_boom();`);
    await migrate();
    expect((await db.query(`select topic, subtopic from public.cards`)).rows).toEqual([{ topic: "Countries", subtopic: "United Kingdom" }]);
    expect((await db.query(`select topic, subtopic from public.user_subtopics order by 2`)).rows).toEqual([{ topic: "Countries", subtopic: "United Kingdom" }]);
  });

  it("at the first insert rolls back the inert-row delete before it", async () => {
    await seed();
    const before = await snapshot();
    await db.exec(`
      create function public.qa_boom() returns trigger language plpgsql as $$ begin raise exception 'qa boom'; end $$;
      create trigger qa_boom before insert on public.user_topics for each row execute function public.qa_boom();
    `);
    await expect(migrate()).rejects.toThrow(/qa boom/);
    await db.exec("rollback");
    expect(await snapshot()).toEqual(before);
  });
});

describe("what the new code's getUserProfile returns", () => {
  async function reader(topics: string[], countries: string[] = [], sources: string[] = []) {
    const id = randomUUID();
    await db.query(`insert into auth.users (id) values ($1)`, [id]);
    for (const t of topics) await db.query(`insert into public.user_topics (user_id, topic) values ($1, $2)`, [id, t]);
    for (const c of countries) await db.query(`insert into public.user_subtopics (user_id, topic, subtopic) values ($1, 'Countries', $2)`, [id, c]);
    for (const s of sources) await db.query(`insert into public.user_preferred_sources (user_id, source) values ($1, $2)`, [id, s]);
    return id;
  }

  it("after the deploy but before the second run: drops the retired topic, keeps the rest, and only an all-retired reader comes back empty", async () => {
    const mixed = await reader(["US Politics", "Tech/AI", "Science"]);
    const onlyRetired = await reader(["US Politics", "Morocco Finance"]);
    const withCountries = await reader(["Countries", "UK Politics", "Tech/AI"], ["Germany"]);
    const sb = fakeSupabase();
    expect((await getUserProfile(sb, mixed)).topics).toEqual(["Tech/AI", "Science"]);
    expect((await getUserProfile(sb, onlyRetired)).topics).toEqual([]);
    expect(await getUserProfile(sb, withCountries)).toMatchObject({ topics: ["Tech/AI", "Countries"], countries: ["Germany"] });
  });

  it("after the migration: an all-retired reader has Countries and its countries, and removed outlets drop out", async () => {
    const id = await reader(["US Politics", "French Politics", "Morocco Finance"], [], ["Fortune", "RFI (FR)", "MarketWatch", "NPR"]);
    await migrate();
    const p = await getUserProfile(fakeSupabase(), id);
    expect(p).toMatchObject({
      topics: ["Countries"],
      countries: ["France", "Morocco", "United States"],
      preferredSources: ["NPR"],
    });
  });
});
