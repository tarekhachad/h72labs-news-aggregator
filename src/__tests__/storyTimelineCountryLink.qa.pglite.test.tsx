import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A story timeline's "earlier day" link to a card the single-country
// migration refiled under Countries, end to end on a real Postgres: the
// migration sets the card's country, getCardsForTopicOnDate and
// getStoryTimelines read it back through a PostgREST look-alike that honours
// the select list, storyDayHref builds the link, and the real history page
// renders that link's day with more Countries cards than the unfiltered page
// shows. The card must be on the page the link opens.

type PG = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const schema = readFileSync(path.resolve(__dirname, "../../supabase/schema.sql"), "utf8");
const block = schema.slice(schema.indexOf("-- V2.7 migration: the six single-country topics become their countries."));

let db: PG;
let reader = "";

/** Runs one statement as the signed-in reader, under RLS. */
async function asReader<T>(sql: string, params: unknown[]): Promise<T[]> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${reader}', false); set role authenticated;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

/**
 * Enough of supabase-js for getCardsForTopicOnDate, getBookmarkedCardIds and
 * getStoryTimelines: select (plain columns and one `digests!inner(...)`
 * embed), eq (on the table or the embed), in, order, maybeSingle. Only the
 * columns named in the select come back, so a column the code forgets to
 * select is missing here too.
 */
function pgSupabase(): SupabaseClient {
  const from = (table: string) => {
    let cols: string[] = [];
    let embed: string[] | null = null;
    const where: string[] = [];
    const params: unknown[] = [];
    const orders: string[] = [];
    const run = async () => {
      const select = [
        ...cols.map((c) => `t.${c}`),
        ...(embed ? [`json_build_object(${embed.map((c) => `'${c}', d.${c}${c === "date" ? "::text" : ""}`).join(", ")}) as digests`] : []),
      ].join(", ");
      const join = embed ? " join public.digests d on d.id = t.digest_id" : "";
      const sql = `select ${select} from public.${table} t${join}${where.length ? ` where ${where.join(" and ")}` : ""}${orders.length ? ` order by ${orders.join(", ")}` : ""}`;
      try {
        return { data: await asReader<Record<string, unknown>>(sql, params), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    };
    const col = (c: string) => (c.startsWith("digests.") ? `d.${c.slice(8)}` : `t.${c}`);
    const b = {
      select(s: string) {
        const m = s.match(/digests!inner\(([^)]*)\)/);
        embed = m ? m[1].split(",").map((x) => x.trim()) : null;
        cols = s.replace(/,?\s*digests!inner\([^)]*\)/, "").split(",").map((x) => x.trim()).filter(Boolean);
        return b;
      },
      eq(c: string, v: unknown) {
        params.push(v);
        where.push(`${col(c)} = $${params.length}`);
        return b;
      },
      in(c: string, v: unknown[]) {
        params.push(v);
        where.push(`${col(c)}::text = any($${params.length}::text[])`);
        return b;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orders.push(`${col(c)} ${o?.ascending === false ? "desc" : "asc"}`);
        return b;
      },
      async maybeSingle() {
        const r = await run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        return run().then(resolve, reject);
      },
    };
    return b;
  };
  return { from, auth: { getUser: async () => ({ data: { user: { id: reader } } }) } } as unknown as SupabaseClient;
}

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  client: null as unknown,
  today: "2026-10-14",
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, usePathname: () => "/", useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => mocks.client) }));
vi.mock("@/lib/profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profile")>()),
  getUserProfile: vi.fn(async () => ({ topics: ["Countries", "Geopolitics"], preferredSources: [], countries: ["United States"], timeZone: "UTC" })),
}));
vi.mock("@/lib/digests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/digests")>()),
  todayDateString: () => mocks.today,
}));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));
vi.mock("@/components/newspaper/TopicNav", () => ({ TopicNav: () => null }));

const { default: HistoryTopicPage } = await import("@/app/(paper)/history/[date]/topic/[slug]/page");
const { getCardsForTopicOnDate } = await import("@/lib/digests");
const { storyDayHref } = await import("@/components/newspaper/NewsCard");
const { COUNTRIES_ALL_LIMIT } = await import("@/components/newspaper/TopicPage");

const OTHER_COUNTRIES = ["Kenya", "Uganda", "Germany", "Japan", "Brazil", "India", "Canada", "Mexico", "Nigeria", "Egypt", "Spain", "Italy"];

let refiled = "";
let today13 = "";

beforeAll(async () => {
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
  reader = (await db.query<{ id: string }>(`insert into auth.users (email) values ('r@x.com') returning id`)).rows[0].id;
  for (const t of ["US Politics", "Countries", "Geopolitics"]) await db.query(`insert into public.user_topics (user_id, topic) values ($1, $2)`, [reader, t]);
  for (const c of OTHER_COUNTRIES) await db.query(`insert into public.user_subtopics (user_id, topic, subtopic) values ($1, 'Countries', $2)`, [reader, c]);

  const day10 = (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date) values (gen_random_uuid(), $1, '2026-10-10') returning id`, [reader])).rows[0].id;
  const day13 = (await db.query<{ id: string }>(`insert into public.digests (id, user_id, date) values (gen_random_uuid(), $1, '2026-10-13') returning id`, [reader])).rows[0].id;
  const insertCard = (id: string, digest: string, topic: string, subtopic: string | null, severity: number, story: string | null) =>
    db.query(
      `insert into public.cards (id, digest_id, topic, subtopic, short_summary, sources, published_at, severity, title, story_id)
       values ($1, $2, $3, $4, 's', '[]', '2026-10-10T12:00:00Z', $5, $6, $7)`,
      [id, digest, topic, subtopic, severity, `Title ${id}`, story]
    );
  // Twelve other countries' cards, all more important than the US story.
  for (const c of OTHER_COUNTRIES) await insertCard(randomUUID(), day10, "Countries", c, 5, null);
  // The US story's first day, filed under the topic the migration removes.
  refiled = randomUUID();
  await insertCard(refiled, day10, "US Politics", null, 1, refiled);
  // Its next day, under another topic.
  today13 = randomUUID();
  await insertCard(today13, day13, "Geopolitics", null, 4, refiled);

  await db.exec(block);
  mocks.client = pgSupabase();
});

beforeEach(() => {
  mocks.redirect.mockClear();
  mocks.today = "2026-10-14";
});

async function earlierEntryHref(): Promise<{ href: string; entry: unknown }> {
  const [card] = await getCardsForTopicOnDate(mocks.client as SupabaseClient, reader, "2026-10-13", "Geopolitics");
  expect(card.id).toBe(today13);
  const entry = card.timeline?.earlier[0];
  if (!entry) throw new Error("no timeline entry");
  return { href: storyDayHref(entry), entry };
}

async function renderHistory(href: string): Promise<string> {
  const url = new URL(href, "https://pna.example");
  const [, , date, , slug] = url.pathname.split("/");
  const el = await HistoryTopicPage({
    params: Promise.resolve({ date, slug }),
    searchParams: Promise.resolve(Object.fromEntries(url.searchParams)),
  });
  return renderToStaticMarkup(el);
}

describe("an earlier-day link to a card the migration refiled under Countries", () => {
  it("the migration really filed it as Countries · United States, on a day with more Countries cards than the unfiltered page shows", async () => {
    const rows = (await db.query<{ topic: string; subtopic: string }>(`select topic, subtopic from public.cards where id = $1`, [refiled])).rows;
    expect(rows).toEqual([{ topic: "Countries", subtopic: "United States" }]);
    const n = (await db.query<{ n: number }>(`select count(*)::int as n from public.cards c join public.digests d on d.id = c.digest_id where d.date = '2026-10-10' and c.topic = 'Countries'`)).rows[0].n;
    expect(n).toBeGreaterThan(COUNTRIES_ALL_LIMIT);
  });

  it("reads the card's country through the timeline and links to that country's filter", async () => {
    const { href, entry } = await earlierEntryHref();
    expect(entry).toEqual({ id: refiled, date: "2026-10-10", title: `Title ${refiled}`, topic: "Countries", subtopic: "United States" });
    expect(href).toBe(`/history/2026-10-10/topic/countries?country=united-states#card-${refiled}`);
  });

  it("opens a page that has the card on it, filtered exactly as the page's own country filter link would", async () => {
    const { href } = await earlierEntryHref();
    const html = await renderHistory(href);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(html).toContain(`id="card-${refiled}"`);
    // CountryFilter's own link for the country is the link's page and query.
    const filterLinks = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => ({ href: m[1].replaceAll("&amp;", "&"), label: m[2] }));
    const us = filterLinks.find((l) => l.label === "United States");
    expect(us?.href).toBe(href.slice(0, href.indexOf("#")));
    expect(html).toMatch(/aria-current="page"[^>]*>United States</);
  });

  it("without the country, the day's unfiltered Countries page leaves the card off (why the link needs it)", async () => {
    const html = await renderHistory(`/history/2026-10-10/topic/countries#card-${refiled}`);
    expect(html).toContain('aria-label="Filter by country"');
    expect(html).not.toContain(`id="card-${refiled}"`);
  });

  it("if the linked day has become today, the page's redirect keeps the country (the fragment is not part of what the server sees)", async () => {
    mocks.today = "2026-10-10";
    const { href } = await earlierEntryHref();
    await expect(renderHistory(href)).rejects.toThrow(new Error("REDIRECT:/topic/countries?country=united-states"));
  });
});
