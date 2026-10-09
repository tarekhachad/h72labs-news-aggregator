import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { saveGeneratedCards } from "@/lib/digests";
import type { Card } from "@/types";

// Read-only checks on supabase/schema.sql: nothing here runs SQL.
const schema = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8");

/** Strip `-- ...` line comments (the file uses no block comments in these sections). */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

/** Split on commas at paren depth 0. */
function topLevelSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function persistBody(): string {
  const start = schema.indexOf("create or replace function public.persist_generated_cards(");
  return stripComments(schema.slice(start, schema.indexOf("\n$$;", start)));
}

describe("QA: persist_generated_cards insert pairs subtopic positionally", () => {
  it("there is exactly one persist_generated_cards definition", () => {
    expect(schema.match(/create or replace function public\.persist_generated_cards\(/g)).toHaveLength(1);
  });

  it("the insert's column count equals the select's expression count, and subtopic pairs with c->>'subtopic'", () => {
    const body = persistBody();
    const m = /insert into public\.cards \(([^)]*)\)\s*select([\s\S]*?)\bfrom jsonb_array_elements\(p_cards\)/.exec(body);
    expect(m).not.toBeNull();
    const cols = m![1].split(",").map((c) => c.trim());
    const exprs = topLevelSplit(m![2]);
    expect(exprs).toHaveLength(cols.length);
    expect(exprs[cols.indexOf("subtopic")]).toBe("c->>'subtopic'");
    expect(exprs[cols.indexOf("labels")]).toBe("coalesce(c->'labels', '[]'::jsonb)");
    expect(exprs[cols.indexOf("topic")]).toBe("c->>'topic'");
  });
});

describe("QA: the V2.5 block", () => {
  const v25 = schema.slice(schema.indexOf("-- V2.5 migration"));
  const code = stripComments(v25);

  it("adds cards.subtopic as nullable text, re-runnably", () => {
    expect(code).toMatch(/alter table public\.cards add column if not exists subtopic text;/);
  });

  it("user_subtopics: composite PK (user_id, topic, subtopic), FK to auth.users with cascade, RLS on", () => {
    expect(code).toMatch(/create table if not exists public\.user_subtopics \(/);
    expect(code).toMatch(/user_id uuid not null references auth\.users\(id\) on delete cascade/);
    expect(code).toMatch(/primary key \(user_id, topic, subtopic\)/);
    expect(code).toMatch(/alter table public\.user_subtopics enable row level security;/);
  });

  it("own-row select, insert and delete policies, and no update policy", () => {
    const policies = [...code.matchAll(/create policy "([^"]+)"\s+on public\.user_subtopics for (\w+)\s+(using|with check) \((.*)\);/g)].map(
      (m) => ({ name: m[1], cmd: m[2], clause: m[3], expr: m[4] })
    );
    expect(policies.map((p) => p.cmd).sort()).toEqual(["delete", "insert", "select"]);
    for (const p of policies) expect(p.expr).toBe("auth.uid() = user_id");
    expect(policies.find((p) => p.cmd === "insert")?.clause).toBe("with check");
    expect(code).not.toMatch(/on public\.user_subtopics for (update|all)/);
    // each policy dropped first so the block re-runs
    for (const p of policies) expect(code).toContain(`drop policy if exists "${p.name}" on public.user_subtopics;`);
  });

  it("no other user_subtopics grant or policy elsewhere widens it", () => {
    // Earlier blocks may read the table (persist_generated_cards checks a
    // caller's saved countries); what must not appear is a grant or policy.
    const outside = stripComments(schema.slice(0, schema.indexOf("-- V2.5 migration")));
    expect(outside).not.toMatch(/(grant|revoke|policy)[^;]*user_subtopics/i);
  });
});

describe("QA: saveGeneratedCards payload keys", () => {
  function rpcRecorder() {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      },
    } as unknown as SupabaseClient;
    return { client, calls };
  }
  const base: Omit<Card, "subtopic"> = {
    id: "00000000-0000-0000-0000-000000000001",
    topic: "Science",
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

  it("a card with subtopic absent is sent with subtopic: null (JSON null -> SQL NULL via ->>)", async () => {
    const { client, calls } = rpcRecorder();
    await saveGeneratedCards(client, "d1", [base as Card], "2026-10-03T00:00:00Z", [], []);
    const sent = (calls[0].args.p_cards as Record<string, unknown>[])[0];
    expect(sent).toHaveProperty("subtopic", null);
    expect(JSON.parse(JSON.stringify(sent)).subtopic).toBeNull();
  });

  it("zero-country invariant: a plain card's payload is the old payload plus subtopic: null only", async () => {
    const { client, calls } = rpcRecorder();
    await saveGeneratedCards(client, "d1", [{ ...base, subtopic: null }], "2026-10-03T00:00:00Z", [], []);
    const sent = (calls[0].args.p_cards as Record<string, unknown>[])[0];
    expect(Object.keys(sent).sort()).toEqual(
      ["frontPageRank", "id", "labels", "publishedAt", "severity", "shortSummary", "sources", "subtopic", "title", "topic"].sort()
    );
  });
});
