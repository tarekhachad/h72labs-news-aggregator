import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCardsForTopicOnDate,
  getDigestForDate,
  getTodaysCardSummaries,
  saveGeneratedCards,
} from "@/lib/digests";
import { getSavedCards } from "@/lib/bookmarks";
import type { Card } from "@/types";

// PostgREST rejects a select or an insert that names a column the table does
// not have, so a column the code reads or writes before the migration adding
// it has run fails every digest load or every save. This holds the code to
// public.cards as supabase/schema.sql defines it (the create table plus every
// `alter table public.cards add column`), the same way
// usageRecord.schema.qa2.test.ts holds the usage sink to usage_runs.
//
// The select strings are captured from the real read functions against a
// recording client, not grepped out of the source, so a select written any
// way at all is still checked.

// With `--` comments stripped, so a commented-out `alter table` (or insert
// column) counts as the missing column it is. No string literal in the parts
// read here contains `--`.
const schema = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8").replace(/--.*$/gm, "");

function cardsColumns(sql: string): Set<string> {
  const cols = new Set<string>();
  const start = sql.indexOf("create table public.cards (");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n);", start);
  for (const line of sql.slice(start, end).split("\n").slice(1)) {
    const m = /^\s+([a-z_][a-z0-9_]*)\s+(uuid|text|smallint|integer|boolean|jsonb|numeric|timestamptz|date)\b/.exec(line);
    if (m) cols.add(m[1]);
  }
  for (const m of sql.matchAll(/alter table public\.cards add column(?: if not exists)? ([a-z_][a-z0-9_]*)/g)) {
    cols.add(m[1]);
  }
  return cols;
}

/** The column list of persist_generated_cards' insert into public.cards. */
function persistInsertColumns(sql: string): string[] {
  const start = sql.indexOf("create or replace function public.persist_generated_cards(");
  expect(start).toBeGreaterThanOrEqual(0);
  const body = sql.slice(start, sql.indexOf("\n$$;", start));
  const m = /insert into public\.cards \(([^)]*)\)/.exec(body);
  expect(m).not.toBeNull();
  return m![1].split(",").map((c) => c.trim());
}

/** The keys persist_generated_cards reads from each p_cards element (`c->>'x'` / `c->'x'`). */
function persistCardKeys(sql: string): Set<string> {
  const start = sql.indexOf("create or replace function public.persist_generated_cards(");
  const body = sql.slice(start, sql.indexOf("\n$$;", start));
  return new Set([...body.matchAll(/\bc->>?'([A-Za-z_]+)'/g)].map((m) => m[1]));
}

/** Column names in a PostgREST select string, embedded resources flattened by table. */
function selectColumns(select: string): { table: string | null; column: string }[] {
  const out: { table: string | null; column: string }[] = [];
  const stack: (string | null)[] = [null];
  let token = "";
  const flush = () => {
    const name = token.trim();
    if (name !== "") out.push({ table: stack[stack.length - 1], column: name });
    token = "";
  };
  for (const ch of select) {
    if (ch === "(") {
      stack.push(token.trim());
      token = "";
    } else if (ch === ")") {
      flush();
      stack.pop();
    } else if (ch === ",") {
      flush();
    } else {
      token += ch;
    }
  }
  flush();
  return out;
}

interface Recorded {
  table: string;
  select?: string;
  rpc?: { name: string; args: Record<string, unknown> };
}

/**
 * A client that records every from().select() and rpc(), and answers each
 * query with one row so a function reaches its second query (the cards read
 * comes after the digest lookup).
 */
function recordingClient(): { client: SupabaseClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const result = { data: [{ id: "d1", date: "2026-10-03", last_generated_at: null }], error: null };
  const from = (table: string) => {
    const call: Recorded = { table };
    calls.push(call);
    const chain: Record<string, unknown> = {};
    for (const method of ["eq", "order", "limit", "not", "gte", "lte", "in"]) {
      chain[method] = () => chain;
    }
    chain.select = (s: string) => {
      call.select = s;
      return chain;
    };
    chain.maybeSingle = () => Promise.resolve({ data: result.data[0], error: null });
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return chain;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    calls.push({ table: "rpc", rpc: { name, args } });
    return Promise.resolve({ data: null, error: null });
  };
  return { client: { from, rpc } as unknown as SupabaseClient, calls };
}

async function cardSelectsSent(): Promise<string[]> {
  const { client, calls } = recordingClient();
  await getDigestForDate(client, "u1", "2026-10-03").catch(() => null);
  await getCardsForTopicOnDate(client, "u1", "2026-10-03", "Tech/AI").catch(() => null);
  await getTodaysCardSummaries(client, "d1").catch(() => null);
  await getSavedCards(client, "u1").catch(() => null);
  const columns: string[] = [];
  for (const call of calls) {
    if (call.select === undefined) continue;
    for (const { table, column } of selectColumns(call.select)) {
      const isCards = table === "cards" || (table === null && call.table === "cards");
      if (isCards) columns.push(column);
    }
  }
  return columns;
}

describe("cards: code vs supabase/schema.sql", () => {
  it("parses the existing columns (fixture sanity)", () => {
    const cols = cardsColumns(schema);
    for (const c of ["id", "digest_id", "topic", "severity", "front_page_rank", "title", "labels", "subtopic"]) {
      expect(cols.has(c), c).toBe(true);
    }
  });

  it("every column persist_generated_cards inserts exists", () => {
    const cols = cardsColumns(schema);
    const inserted = persistInsertColumns(schema);
    expect(inserted).toContain("subtopic");
    expect(inserted.filter((c) => !cols.has(c))).toEqual([]);
  });

  it("every cards column the read functions select exists", async () => {
    const cols = cardsColumns(schema);
    const selected = await cardSelectsSent();
    // Four reads, each naming several columns: an empty capture would pass
    // the filter below while checking nothing.
    expect(selected.length).toBeGreaterThan(20);
    expect(selected).toContain("subtopic");
    expect([...new Set(selected.filter((c) => !cols.has(c)))]).toEqual([]);
  });

  it("every key saveGeneratedCards sends is one persist_generated_cards reads", async () => {
    const { client, calls } = recordingClient();
    const card: Card = {
      id: "00000000-0000-0000-0000-000000000001",
      topic: "Countries",
      subtopic: "Uganda",
      title: "t",
      shortSummary: "s",
      labels: [],
      expandedReport: null,
      sources: [],
      publishedAt: "2026-10-03T00:00:00Z",
      generatedAt: "2026-10-03T00:00:00Z",
      bookmarked: false,
      severity: 3,
      frontPageRank: null,
    };
    await saveGeneratedCards(client, "d1", [card], "2026-10-03T00:00:00Z", []);
    const sent = calls.find((c) => c.rpc?.name === "persist_generated_cards")!.rpc!.args.p_cards as Record<
      string,
      unknown
    >[];
    const read = persistCardKeys(schema);
    expect(read.has("subtopic")).toBe(true);
    expect(Object.keys(sent[0]).filter((k) => !read.has(k))).toEqual([]);
    expect(sent[0].subtopic).toBe("Uganda");
  });
});
