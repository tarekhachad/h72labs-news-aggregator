import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getUnitReadTimes } from "@/lib/digests";
import { readingUnits, unitKey, type ReadingUnit } from "@/lib/readingUnits";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";
import { TOPICS, type Topic } from "@/types";

// getUnitReadTimes' two-query lookup through the real supabase-js builder,
// answered by a fake fetch that parses each request the way PostgREST does
// (quoted IN-list values, `in.()` as the empty list) and applies PostgREST's
// 1000-row cap with the worst ordering: every junk row before any real one.
// No network: the fetch never leaves the process.

type Row = { user_id: string; topic: string; subtopic: string; read_at: string };
const MAX_ROWS = 1000;

/** PostgREST's IN-list grammar: comma-separated, "double-quoted" values may hold , ( ) and \-escapes. */
function parseInList(raw: string): string[] {
  const inner = raw.slice("in.(".length, -1);
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted && ch === "\\") cur += inner[++i];
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.length === 1 && out[0] === "" ? [] : out;
}

function fakePostgrest(rows: Row[], opts: { failWhen?: (url: URL) => "error" | "reject" | null } = {}) {
  const urls: URL[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const fail = opts.failWhen?.(url) ?? null;
    if (fail === "reject") throw new TypeError("fetch failed");
    if (fail === "error") {
      return new Response(JSON.stringify({ message: "boom", code: "XX000" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    let result = rows;
    for (const [col, filter] of url.searchParams.entries()) {
      if (col === "select") continue;
      const c = col as keyof Row;
      if (filter.startsWith("eq.")) result = result.filter((r) => r[c] === filter.slice(3));
      else if (filter.startsWith("in.(") && filter.endsWith(")")) {
        const list = parseInList(filter);
        result = result.filter((r) => list.includes(r[c]));
      } else if (filter.startsWith("lte.")) result = result.filter((r) => new Date(r[c]).getTime() <= new Date(filter.slice(4)).getTime());
      else throw new Error(`fake PostgREST: unhandled filter ${col}=${filter}`);
    }
    const body = result.slice(0, MAX_ROWS).map(({ topic, subtopic, read_at }) => ({ topic, subtopic, read_at }));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createClient("http://fake.local", "anon-key", {
    global: { fetch: fetch as unknown as typeof globalThis.fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, urls };
}

/** Every IN list a request carries, parsed, so an empty element or empty list is visible. */
function inLists(url: URL): string[][] {
  return [...url.searchParams.entries()].filter(([, f]) => f.startsWith("in.")).map(([, f]) => parseInList(f));
}

const T_OLD = "2026-10-08T07:00:00+00:00";
const T_REAL = "2026-10-09T08:00:00.123+00:00";
const U = "u1";
const C = COUNTRIES_TOPIC as Topic;
const plain = (topic: string): ReadingUnit => ({ topic: topic as Topic, subtopic: null });
const country = (name: string): ReadingUnit => ({ topic: C, subtopic: name });
const realRow = (u: ReadingUnit, read_at = T_REAL): Row => ({ user_id: U, topic: u.topic, subtopic: u.subtopic ?? "", read_at });

/**
 * Every row a direct client can make persist_generated_cards write for this
 * user, all ordered before the real rows: junk saved topics (subtopic ''),
 * junk countries under Countries, and an empty country. (A plain topic with a
 * non-empty subtopic is impossible: the SQL harness proves persist never
 * writes one.) Plus another user's rows for the same units.
 */
function flood(n = 1500): Row[] {
  const junk: Row[] = [];
  for (let i = 0; i < n; i++) {
    junk.push({ user_id: U, topic: `junk${i}`, subtopic: "", read_at: T_OLD });
    junk.push({ user_id: U, topic: C, subtopic: `Junkland ${i}`, read_at: T_OLD });
  }
  junk.push({ user_id: U, topic: C, subtopic: "", read_at: T_OLD });
  for (const t of TOPICS) junk.push({ user_id: "u2", topic: t, subtopic: "", read_at: T_OLD });
  for (const k of COUNTRIES) junk.push({ user_id: "u2", topic: C, subtopic: k, read_at: T_OLD });
  return junk;
}

describe("getUnitReadTimes: request shape for every profile", () => {
  it("topics only: one request, filtered by topic, with no subtopic filter of any kind", async () => {
    const units = [plain("Tech/AI"), plain("Space"), plain("Consumer Tech & Gadgets")];
    const { client, urls } = fakePostgrest(units.map((u) => realRow(u)));

    const times = await getUnitReadTimes(client, U, units);

    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.has("subtopic")).toBe(false);
    expect(inLists(urls[0])).toEqual([["Tech/AI", "Space", "Consumer Tech & Gadgets"]]);
    expect(times.size).toBe(3);
  });

  it("countries only: one request, topic=eq.Countries and the names, never a plain-topic request", async () => {
    const units = [country("France"), country("Côte d'Ivoire")];
    const { client, urls } = fakePostgrest(units.map((u) => realRow(u)));

    const times = await getUnitReadTimes(client, U, units);

    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.get("topic")).toBe("eq.Countries");
    expect(inLists(urls[0])).toEqual([["France", "Côte d'Ivoire"]]);
    expect([...times.keys()].sort()).toEqual(units.map((u) => unitKey(u.topic, u.subtopic)).sort());
  });

  it("one country and one topic: two requests, each with one non-empty IN list", async () => {
    const units = [plain("Space"), country("Morocco")];
    const { client, urls } = fakePostgrest(units.map((u) => realRow(u)));

    const times = await getUnitReadTimes(client, U, units);

    expect(urls).toHaveLength(2);
    for (const url of urls) expect(inLists(url).map((l) => l.length)).toEqual([1]);
    expect(times.size).toBe(2);
  });

  it("no units: no request at all", async () => {
    const { client, urls } = fakePostgrest([]);
    expect((await getUnitReadTimes(client, U, [])).size).toBe(0);
    expect(urls).toHaveLength(0);
  });

  it("a name holding , ( ) or an apostrophe survives PostgREST's IN-list parsing", async () => {
    // No curated name holds these today; Côte d'Ivoire is the only one outside A-Z.
    const units = [country("Côte d'Ivoire"), country("Korea, South"), country("Congo (DRC)")];
    const { client } = fakePostgrest(units.map((u) => realRow(u)));

    const times = await getUnitReadTimes(client, U, units);

    expect(times.get(unitKey(C, "Côte d'Ivoire"))).toBe(T_REAL);
    expect(times.get(unitKey(C, "Korea, South"))).toBe(T_REAL);
    expect(times.get(unitKey(C, "Congo (DRC)"))).toBe(T_REAL);
    // supabase-js quotes only , ( ); a curated name holding a double quote or backslash would need escaping.
    expect(COUNTRIES.some((k) => /["\\]/.test(k))).toBe(false);
  });

  it("every curated topic and every curated country round-trips under a 1000-row flood of junk", async () => {
    const units = [...TOPICS.filter((t) => t !== COUNTRIES_TOPIC).map(plain), ...COUNTRIES.map(country)];
    const { client, urls } = fakePostgrest([...flood(), ...units.map((u) => realRow(u))]);

    const times = await getUnitReadTimes(client, U, units);

    expect(times.size).toBe(units.length);
    for (const u of units) expect(times.get(unitKey(u.topic, u.subtopic))).toBe(T_REAL);
    for (const url of urls) for (const list of inLists(url)) expect(list.length).toBeGreaterThan(0);
  });
});

describe("getUnitReadTimes: randomized profiles from readingUnits", () => {
  // Deterministic PRNG so a failure reproduces.
  let seed = 20261009;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: readonly T[], n: number) => [...xs].sort(() => rand() - 0.5).slice(0, n);

  it("400 profiles: never an empty IN list or empty element, every read unit with a row found, never junk", async () => {
    const junk = flood(600);
    for (let i = 0; i < 400; i++) {
      const topics = pick(TOPICS, Math.floor(rand() * 8)) as Topic[];
      if (rand() < 0.5 && !topics.includes(C)) topics.push(C);
      const countries = topics.includes(C) ? pick(COUNTRIES, Math.floor(rand() * 6)) : [];
      const { read } = readingUnits(topics, countries);
      const withRow = read.filter(() => rand() < 0.7);
      const { client, urls } = fakePostgrest([...junk, ...withRow.map((u) => realRow(u))]);

      const times = await getUnitReadTimes(client, U, read);

      for (const url of urls) {
        expect(url.search).not.toMatch(/in\.\(\)|in\.\(,|,,|,\)/);
        for (const list of inLists(url)) for (const v of list) expect(v).not.toBe("");
      }
      expect([...times.keys()].sort()).toEqual(withRow.map((u) => unitKey(u.topic, u.subtopic)).sort());
      expect(urls.length).toBe(Number(read.some((u) => !u.subtopic)) + Number(read.some((u) => !!u.subtopic)));
    }
  });
});

describe("getUnitReadTimes: one of the two queries failing", () => {
  const units = [plain("Tech/AI"), country("France")];
  const rows = units.map((u) => realRow(u));
  const isCountryQuery = (url: URL) => url.searchParams.get("topic") === "eq.Countries";

  it("throws when only the countries query errors, rather than returning the plain half", async () => {
    const { client } = fakePostgrest(rows, { failWhen: (url) => (isCountryQuery(url) ? "error" : null) });
    await expect(getUnitReadTimes(client, U, units)).rejects.toThrow("getUnitReadTimes: boom");
  });

  it("throws when only the plain-topics query errors", async () => {
    const { client } = fakePostgrest(rows, { failWhen: (url) => (isCountryQuery(url) ? null : "error") });
    await expect(getUnitReadTimes(client, U, units)).rejects.toThrow("getUnitReadTimes: boom");
  });

  it("rejects (and so falls back in the route) when one request's fetch itself fails", async () => {
    const { client } = fakePostgrest(rows, { failWhen: (url) => (isCountryQuery(url) ? "reject" : null) });
    // supabase-js retries a GET whose fetch throws (1s, 2s, 4s backoff) before giving up.
    await expect(getUnitReadTimes(client, U, units)).rejects.toThrow();
  }, 20_000);
});
