import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { backfill } from "../../../scripts/backfill-card-embeddings.mts";

// The backfill through the REAL supabase-js client, with only its fetch
// replaced by a small PostgREST stand-in over an in-memory cards table. The
// other backfill tests drive a hand-written chain; this one checks the HTTP
// the real library sends for that chain: the filters on each update, and
// above all that `.select("id")` after `.update()` asks PostgREST to return
// the changed rows. PostgREST answers an update with no body unless asked
// (Prefer: return=representation), and the script counts an empty answer as
// "skipped", so without that header every real write would be miscounted.

type Row = { id: string; title: string | null; short_summary: string | null; embedding: number[] | null; story_id: string | null };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function postgrest(initial: Row[], hooks: { beforePatch?: (rowId: string, rows: Row[]) => void } = {}) {
  const rows = initial.map((r) => ({ ...r }));
  const requests: { method: string; url: URL; prefer: string; body: unknown }[] = [];

  function matches(row: Row, params: URLSearchParams): boolean {
    for (const [key, raw] of params) {
      if (key === "select" || key === "order" || key === "limit") continue;
      if (key === "or") {
        const inner = raw.replace(/^\(|\)$/g, "").split(",");
        if (!inner.some((clause) => {
          const [col, op, value] = clause.split(".");
          return op === "is" && value === "null" && row[col as keyof Row] === null;
        })) return false;
        continue;
      }
      const dot = raw.indexOf(".");
      const op = raw.slice(0, dot);
      const value = raw.slice(dot + 1);
      const cell = row[key as keyof Row];
      if (op === "is" && value === "null") { if (cell !== null) return false; }
      else if (op === "eq") { if (cell !== value) return false; }
      else if (op === "gt") { if (!(typeof cell === "string" && cell > value)) return false; }
      else throw new Error(`unsupported filter ${key}=${raw}`);
    }
    return true;
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const prefer = headers.get("prefer") ?? "";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, prefer, body });
    if (!url.pathname.endsWith("/rest/v1/cards")) return new Response("not found", { status: 404 });
    const params = url.searchParams;

    if (method === "HEAD" || method === "GET") {
      let hit = rows.filter((r) => matches(r, params));
      if (params.get("order") === "id.asc") hit = [...hit].sort((a, b) => (a.id < b.id ? -1 : 1));
      const limit = params.get("limit");
      if (limit !== null) hit = hit.slice(0, Number(limit));
      const extra: Record<string, string> = { "content-type": "application/json" };
      if (prefer.includes("count=exact")) extra["content-range"] = `0-${Math.max(0, hit.length - 1)}/${hit.length}`;
      const cols = (params.get("select") ?? "*").split(",");
      const shaped = hit.map((r) => Object.fromEntries(cols.map((c) => [c, r[c as keyof Row]])));
      return new Response(method === "HEAD" ? null : JSON.stringify(shaped), { status: 200, headers: extra });
    }

    if (method === "PATCH") {
      const target = params.get("id")?.replace(/^eq\./, "");
      if (target) hooks.beforePatch?.(target, rows);
      const hit = rows.filter((r) => matches(r, params));
      for (const r of hit) Object.assign(r, body);
      if (prefer.includes("return=representation")) {
        const cols = (params.get("select") ?? "*").split(",");
        return new Response(JSON.stringify(hit.map((r) => Object.fromEntries(cols.map((c) => [c, r[c as keyof Row]])))), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }
    return new Response("bad method", { status: 405 });
  };

  const client = createClient("http://postgrest.test", "test-secret-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetch as typeof globalThis.fetch },
  });
  return { client, rows, requests };
}

const vector = (seed: number) => Array.from({ length: 384 }, (_, i) => Math.sin(seed + i) / 20);
const embed = async (texts: string[]) => texts.map((_, i) => vector(i));

function oldCards(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: id(i + 1), title: `T${i}`, short_summary: `S${i}.`, embedding: null, story_id: null }));
}

describe("the backfill through real supabase-js (QA)", () => {
  it("counts every real write as updated: each update asks for the changed rows back", async () => {
    const { client, rows, requests } = postgrest(oldCards(7));
    const counts = await backfill({ client: client as never, embed, write: true, batchSize: 3 });
    expect(counts).toEqual({ missingEmbedding: 7, missingStory: 7, updated: 7, skipped: 0, failed: 0 });
    expect(rows.every((r) => r.embedding?.length === 384 && r.story_id === r.id)).toBe(true);
    const patches = requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(7);
    for (const p of patches) {
      expect(p.prefer).toContain("return=representation");
      expect(p.url.searchParams.get("select")).toBe("id");
      expect(p.url.searchParams.get("embedding")).toBe("is.null");
      expect(p.url.searchParams.get("story_id")).toBe("is.null");
    }
  });

  it("pages by id: each later read starts after the last id of the one before", async () => {
    const { client, requests } = postgrest(oldCards(7));
    await backfill({ client: client as never, embed, write: true, batchSize: 3 });
    const reads = requests.filter((r) => r.method === "GET");
    expect(reads.map((r) => r.url.searchParams.get("id"))).toEqual([null, `gt.${id(3)}`, `gt.${id(6)}`]);
    expect(reads.every((r) => r.url.searchParams.get("or") === "(embedding.is.null,story_id.is.null)")).toBe(true);
  });

  it("counts a card another writer filled between the read and the update as skipped, and leaves it as that writer left it", async () => {
    const theirs = vector(99);
    const { client, rows } = postgrest(oldCards(3), {
      beforePatch: (rowId, all) => {
        if (rowId === id(2)) Object.assign(all.find((r) => r.id === rowId)!, { embedding: theirs, story_id: "99999999-9999-4999-8999-999999999999" });
      },
    });
    const counts = await backfill({ client: client as never, embed, write: true });
    expect(counts).toMatchObject({ updated: 2, skipped: 1, failed: 0 });
    expect(rows.find((r) => r.id === id(2))).toMatchObject({ embedding: theirs, story_id: "99999999-9999-4999-8999-999999999999" });
  });

  it("only sets the story of a card that already has its embedding", async () => {
    const start = oldCards(1);
    start[0].embedding = vector(5);
    const { client, rows, requests } = postgrest(start);
    let embedded = 0;
    const counts = await backfill({ client: client as never, embed: async (t) => ((embedded += t.length), embed(t)), write: true });
    expect(embedded).toBe(0);
    expect(counts).toMatchObject({ updated: 1, skipped: 0 });
    expect(rows[0]).toMatchObject({ embedding: vector(5), story_id: id(1) });
    const patch = requests.find((r) => r.method === "PATCH")!;
    expect(patch.body).toEqual({ story_id: id(1) });
    expect(patch.url.searchParams.has("embedding")).toBe(false);
  });

  it("writes nothing on a dry run, and counts with HEAD requests only", async () => {
    const { client, requests } = postgrest(oldCards(4));
    const counts = await backfill({ client: client as never, embed, write: false });
    expect(counts).toEqual({ missingEmbedding: 4, missingStory: 4, updated: 0, skipped: 0, failed: 0 });
    expect(requests.map((r) => r.method)).toEqual(["HEAD", "HEAD"]);
  });
});
