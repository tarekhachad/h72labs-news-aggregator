import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildUsageRunRecord, toUsageRunRow, type UsageRunContext } from "@/lib/usageRecord";

// QA round 2: the Supabase sink inserts toUsageRunRow(record) as-is, and
// PostgREST rejects an insert naming a column the table does not have, even
// when its value is null. So every key the row carries must be a column of
// public.usage_runs as supabase/schema.sql defines it (create table plus any
// `alter table ... add column`), or every usage row is lost.

const schema = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8");

function usageRunsColumns(sql: string): Set<string> {
  const cols = new Set<string>();
  const start = sql.indexOf("create table public.usage_runs (");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n);", start);
  const block = sql.slice(start, end);
  for (const line of block.split("\n").slice(1)) {
    const m = /^\s+([a-z_][a-z0-9_]*)\s+(uuid|text|smallint|integer|boolean|jsonb|numeric|timestamptz|date)\b/.exec(line);
    if (m) cols.add(m[1]);
  }
  for (const m of sql.matchAll(/alter table public\.usage_runs add column(?: if not exists)? ([a-z_][a-z0-9_]*)/g)) {
    cols.add(m[1]);
  }
  return cols;
}

function minimalRecord() {
  const summary = {
    totalCalls: 0,
    totalCallsWithoutUsage: 0,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    totalBilledUsd: 0,
    totalListUsd: 0,
    unpricedModels: [],
    pricingVerifiedOn: "2026-10-01",
    stages: [],
  };
  const ctx = {
    userId: "u",
    route: "digest",
    digestId: null,
    cardId: null,
    outcome: "complete",
    label: "x",
    runShape: "firstEver",
    topicCount: null,
    sourceCount: null,
    articleCount: null,
    clusterCount: null,
    clustersAfterDedup: null,
    notableCount: null,
    cardsDroppedByCap: null,
    cardsWritten: null,
    cardsFailed: null,
    cardFailures: null,
    triageFailedClosed: null,
    rankApplied: null,
    expectedCalls: {},
  } as unknown as UsageRunContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return buildUsageRunRecord(summary as any, ctx, new Date("2026-10-02T00:00:00Z"), "run-1");
}

describe("usage_runs row vs supabase/schema.sql", () => {
  it("parses the existing columns (fixture sanity)", () => {
    const cols = usageRunsColumns(schema);
    for (const c of ["id", "user_id", "rank_applied", "triage_failed_closed", "card_failures", "stages"]) {
      expect(cols.has(c)).toBe(true);
    }
  });

  it("every column the sink inserts exists in the schema", () => {
    const cols = usageRunsColumns(schema);
    const row = toUsageRunRow(minimalRecord());
    const missing = Object.keys(row).filter((k) => !cols.has(k));
    expect(missing).toEqual([]);
  });

  it("adds clusters_merged with a re-runnable alter, so the live table gains it before the code that sends it", () => {
    expect(schema).toMatch(/alter table public\.usage_runs add column if not exists clusters_merged integer;/);
    expect(Object.keys(toUsageRunRow(minimalRecord()))).toContain("clusters_merged");
  });

  it("writes clusters_merged as null when the run never measured it", () => {
    expect(toUsageRunRow(minimalRecord()).clusters_merged).toBeNull();
  });
});
