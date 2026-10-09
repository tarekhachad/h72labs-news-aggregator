import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getUnitReadTimes } from "@/lib/digests";
import { unitKey } from "@/lib/readingUnits";
import { COUNTRIES_TOPIC } from "@/config/countries";
import type { Topic } from "@/types";

// getUnitReadTimes through the real supabase-js query builder, answered by a
// fake fetch that applies the request's filters the way PostgREST does. No
// network: the fetch never leaves the process.
//
// The rule that matters: PostgREST parses `in.()` as a list holding one empty
// string and treats that list as EMPTY (its SQL is `= any('{}')`), so
// `?subtopic=in.()` matches no row at all, not the rows whose subtopic is ''.
// `in.(,France)` is two values, '' and 'France', and does match ''.

type Row = { user_id: string; topic: string; subtopic: string; read_at: string };

function parseInList(raw: string): string[] {
  const inner = raw.slice("in.(".length, -1);
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of inner) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  // PostgREST: a list that parses to a single empty value is the empty list.
  return out.length === 1 && out[0] === "" ? [] : out;
}

function fakePostgrest(rows: Row[]) {
  const urls: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(decodeURIComponent(url.search));
    const q = url.searchParams;
    let result = rows;
    for (const [col, filter] of q.entries()) {
      if (col === "select") continue;
      const c = col as keyof Row;
      if (filter.startsWith("eq.")) result = result.filter((r) => r[c] === filter.slice(3));
      else if (filter.startsWith("in.(")) {
        const list = parseInList(filter);
        result = result.filter((r) => list.includes(r[c]));
      } else if (filter.startsWith("lte.")) result = result.filter((r) => new Date(r[c]).getTime() <= new Date(filter.slice(4)).getTime());
      else throw new Error(`fake PostgREST: unhandled filter ${col}=${filter}`);
    }
    const body = result.map(({ topic, subtopic, read_at }) => ({ topic, subtopic, read_at }));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createClient("http://fake.local", "anon-key", {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, urls };
}

const TECH = { topic: "Tech/AI" as Topic, subtopic: null };
const SPACE = { topic: "Space" as Topic, subtopic: null };
const SCIENCE = { topic: "Science" as Topic, subtopic: null };
const FRANCE = { topic: COUNTRIES_TOPIC as Topic, subtopic: "France" };

const T1 = "2026-10-09T08:00:00.123+00:00";
const T2 = "2026-10-09T07:00:00+00:00";

const ROWS: Row[] = [
  { user_id: "u1", topic: "Tech/AI", subtopic: "", read_at: T1 },
  { user_id: "u1", topic: "Space", subtopic: "", read_at: T1 },
  { user_id: "u1", topic: "Science", subtopic: "", read_at: T1 },
  { user_id: "u1", topic: COUNTRIES_TOPIC, subtopic: "France", read_at: T2 },
  { user_id: "u2", topic: "Tech/AI", subtopic: "", read_at: T2 },
];

describe("getUnitReadTimes against PostgREST filter semantics", () => {
  it("finds a reader's plain-topic read times when they pick no country", async () => {
    // The common profile: three plain topics, no Countries.
    const { client, urls } = fakePostgrest(ROWS);

    const times = await getUnitReadTimes(client, "u1", [TECH, SPACE, SCIENCE]);

    // If this is empty, every unit of this reader looks never-read on every
    // run: full 48h lookback and a first run's card allowance each time.
    expect(urls[0]).not.toContain("subtopic=in.()");
    expect(times.get(unitKey("Tech/AI", null))).toBe(T1);
    expect(times.get(unitKey("Space", null))).toBe(T1);
    expect(times.get(unitKey("Science", null))).toBe(T1);
    expect(times.size).toBe(3);
  });

  it("finds plain topics and countries together when a country is picked", async () => {
    const { client } = fakePostgrest(ROWS);

    const times = await getUnitReadTimes(client, "u1", [TECH, SPACE, FRANCE]);

    expect(times.get(unitKey("Tech/AI", null))).toBe(T1);
    expect(times.get(unitKey("Space", null))).toBe(T1);
    expect(times.get(unitKey(COUNTRIES_TOPIC as Topic, "France"))).toBe(T2);
    expect(times.size).toBe(3);
  });

  it("finds countries alone, and never another user's rows", async () => {
    const { client } = fakePostgrest([
      ...ROWS,
      { user_id: "u1", topic: COUNTRIES_TOPIC, subtopic: "Morocco", read_at: T1 },
      { user_id: "u2", topic: COUNTRIES_TOPIC, subtopic: "Kenya", read_at: T1 },
    ]);

    const times = await getUnitReadTimes(client, "u1", [
      FRANCE,
      { topic: COUNTRIES_TOPIC as Topic, subtopic: "Morocco" },
      { topic: COUNTRIES_TOPIC as Topic, subtopic: "Kenya" },
    ]);

    expect([...times.entries()].sort()).toEqual(
      [
        [unitKey(COUNTRIES_TOPIC as Topic, "France"), T2],
        [unitKey(COUNTRIES_TOPIC as Topic, "Morocco"), T1],
      ].sort()
    );
  });
});
