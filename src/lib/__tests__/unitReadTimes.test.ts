import { describe, it, expect, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getUnitReadTimes, saveGeneratedCards } from "@/lib/digests";
import { unitKey } from "@/lib/readingUnits";
import { COUNTRIES_TOPIC } from "@/config/countries";
import type { Topic } from "@/types";

// Each reading unit's own read time: loaded by getUnitReadTimes, written by
// persist_generated_cards through saveGeneratedCards, stored in
// unit_read_cursors, which signed-in users can read but never write.

/**
 * A real supabase-js client whose network layer records each request and
 * answers with `rows` (filtered by nothing: the test controls what comes
 * back). What is asserted is the URL PostgREST would actually receive, not
 * the arguments handed to the library: an argument list can look right and
 * still encode to a filter that matches nothing.
 */
function recordingClient(rows: unknown[] | ((url: URL) => unknown[]), status = 200) {
  const urls: URL[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    const body = status === 200 ? (typeof rows === "function" ? rows(url) : rows) : { message: "boom", code: "XX000" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  const client = createClient("https://example.supabase.co", "anon-key", {
    global: { fetch: fetch as unknown as typeof globalThis.fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, urls };
}

/** A request's filter on one column, decoded (e.g. "in.(Tech/AI,Space)"). */
const filterOn = (url: URL, column: string) => url.searchParams.get(column);

const TECH = { topic: "Tech/AI" as Topic, subtopic: null };
const SPACE = { topic: "Space" as Topic, subtopic: null };
const FRANCE = { topic: COUNTRIES_TOPIC as Topic, subtopic: "France" };
const IVORY = { topic: COUNTRIES_TOPIC as Topic, subtopic: "Côte d'Ivoire" };

describe("getUnitReadTimes", () => {
  it("maps each row to its unit's key, a plain topic's '' subtopic matching null", async () => {
    const { client } = recordingClient((url) =>
      filterOn(url, "subtopic")
        ? [{ topic: COUNTRIES_TOPIC, subtopic: "France", read_at: "2026-10-09T07:00:00Z" }]
        : [{ topic: "Tech/AI", subtopic: "", read_at: "2026-10-09T08:00:00Z" }]
    );

    const times = await getUnitReadTimes(client, "user-1", [TECH, FRANCE]);

    expect(times.get(unitKey("Tech/AI", null))).toBe("2026-10-09T08:00:00Z");
    expect(times.get(unitKey(COUNTRIES_TOPIC as Topic, "France"))).toBe("2026-10-09T07:00:00Z");
    expect(times.size).toBe(2);
  });

  it("asks for plain topics by topic alone, with no subtopic filter at all", async () => {
    const { client, urls } = recordingClient([]);

    await getUnitReadTimes(client, "user-1", [TECH, SPACE]);

    expect(urls).toHaveLength(1);
    expect(urls[0].pathname).toBe("/rest/v1/unit_read_cursors");
    expect(filterOn(urls[0], "user_id")).toBe("eq.user-1");
    expect(filterOn(urls[0], "topic")).toBe("in.(Tech/AI,Space)");
    expect(filterOn(urls[0], "subtopic")).toBeNull();
  });

  it("asks for countries by name under Countries, never sending an empty IN list", async () => {
    const { client, urls } = recordingClient([]);

    await getUnitReadTimes(client, "user-1", [TECH, FRANCE, IVORY]);

    expect(urls).toHaveLength(2);
    const countryUrl = urls.find((u) => filterOn(u, "subtopic") !== null)!;
    expect(filterOn(countryUrl, "topic")).toBe(`eq.${COUNTRIES_TOPIC}`);
    expect(filterOn(countryUrl, "subtopic")).toBe("in.(France,Côte d'Ivoire)");
    for (const url of urls) expect(url.search).not.toMatch(/in\.%28%29|in\.\(\)/);
  });

  it("drops a row for a unit not being read, whatever comes back", async () => {
    const { client } = recordingClient([
      { topic: "Tech/AI", subtopic: "", read_at: "2026-10-09T08:00:00Z" },
      { topic: "Tech/AI", subtopic: "France", read_at: "2026-10-09T09:00:00Z" },
      { topic: COUNTRIES_TOPIC, subtopic: "", read_at: "2026-10-09T09:00:00Z" },
    ]);

    const times = await getUnitReadTimes(client, "user-1", [TECH]);

    expect([...times.keys()]).toEqual([unitKey("Tech/AI", null)]);
  });

  it("asks for nothing when no unit is read", async () => {
    const { client, urls } = recordingClient([]);

    expect((await getUnitReadTimes(client, "user-1", [])).size).toBe(0);
    expect(urls).toHaveLength(0);
  });

  it("leaves out rows implausibly far ahead of the clock, as the run cursor's query does", async () => {
    const { client, urls } = recordingClient([]);
    const before = Date.now();

    await getUnitReadTimes(client, "user-1", [TECH]);

    const limit = filterOn(urls[0], "read_at")!;
    expect(limit.startsWith("lte.")).toBe(true);
    const ahead = new Date(limit.slice(4)).getTime() - before;
    // Five minutes ahead, the shared FUTURE_CURSOR_TOLERANCE_MS.
    expect(ahead).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
    expect(ahead).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });

  it("throws on a failed query, so the route can fall back to the run cursor", async () => {
    const { client } = recordingClient([], 500);

    await expect(getUnitReadTimes(client, "user-1", [TECH])).rejects.toThrow("getUnitReadTimes: boom");
  });
});

describe("saveGeneratedCards", () => {
  it("sends the units this run read as p_units, a plain topic with subtopic null", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });

    await saveGeneratedCards({ rpc } as never, "d1", [], "2026-10-09T12:00:00Z", [], [
      { topic: "Tech/AI", subtopic: null },
      { topic: COUNTRIES_TOPIC as Topic, subtopic: "Kenya" },
    ]);

    expect(rpc).toHaveBeenCalledWith("persist_generated_cards", expect.objectContaining({
      p_units: [
        { topic: "Tech/AI", subtopic: null },
        { topic: COUNTRIES_TOPIC, subtopic: "Kenya" },
      ],
    }));
  });
});

describe("schema.sql: unit_read_cursors", () => {
  const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");

  it("lets signed-in users read their own rows and gives them no way to write one", () => {
    expect(schema).toMatch(/alter table public\.unit_read_cursors enable row level security;/);
    expect(schema).toMatch(/on public\.unit_read_cursors for select\s+using \(auth\.uid\(\) = user_id\);/);
    expect(schema).not.toMatch(/on public\.unit_read_cursors for (insert|update|delete|all)/);
  });

  it("is written only by persist_generated_cards, for saved units only, with the run's own time, never moving backwards", () => {
    const start = schema.indexOf("create or replace function public.persist_generated_cards(");
    const body = schema.slice(start, schema.indexOf("$$;", start));
    expect(body).toMatch(/p_units jsonb default '\[\]'::jsonb/);
    expect(body).toMatch(/insert into public\.unit_read_cursors \(user_id, topic, subtopic, read_at\)\s+select distinct v_user,/);
    expect(body).toMatch(/set read_at = greatest\(public\.unit_read_cursors\.read_at, excluded\.read_at\)/);
    expect(body).toMatch(/jsonb_array_length\(p_units\) > 32/);
    expect(body).toMatch(/select 1 from public\.user_topics t\s+where t\.user_id = v_user and t\.topic = u->>'topic'/);
    expect(body).toMatch(/select 1 from public\.user_subtopics s\s+where s\.user_id = v_user and s\.topic = 'Countries' and s\.subtopic = u->>'subtopic'/);
    // The unit rows come after the window check on p_generated_at, so a direct
    // caller can only mark units read "now".
    expect(body.indexOf("p_generated_at is outside the accepted window")).toBeLessThan(
      body.indexOf("insert into public.unit_read_cursors")
    );
  });

  it("backfills by moving read times forward, so a second pass after the deploy catches runs in between", () => {
    const block = schema.slice(schema.indexOf("-- V2.7 migration: each reading unit's own read time."));
    expect(block.match(/do update\s+set read_at = greatest\(public\.unit_read_cursors\.read_at, excluded\.read_at\);/g)).toHaveLength(2);
    expect(block).not.toMatch(/do nothing/);
  });

  it("drops the 4-argument signature, so no old overload stays callable beside the new one", () => {
    expect(schema).toContain("drop function if exists public.persist_generated_cards(uuid, jsonb, timestamptz, jsonb);");
  });
});
