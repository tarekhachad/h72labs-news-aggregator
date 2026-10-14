import { describe, it, expect, vi } from "vitest";
import { backfill, embedLocally, storyText as scriptStoryText } from "../../../scripts/backfill-card-embeddings.mts";
import { storyText } from "@/lib/storyTimeline";
import { embed } from "@/lib/embeddings";

// The backfill script's logic, against an in-memory cards table that answers
// the same PostgREST calls the script makes. It never touches a database.

type Row = { id: string; title: string | null; short_summary: string | null; embedding: number[] | null; story_id: string | null };

/** A minimal stand-in for supabase-js over one table, honouring the filters the script uses. */
function fakeCards(initial: Row[], opts: { failUpdateFor?: Set<string> } = {}) {
  const rows = initial.map((r) => ({ ...r }));
  const log: string[] = [];

  function selectQuery(head: boolean) {
    const filters: ((r: Row) => boolean)[] = [];
    let limit = Infinity;
    const q = {
      is(col: keyof Row, value: null) {
        filters.push((r) => r[col] === value);
        return q;
      },
      or(expr: string) {
        expect(expr).toBe("embedding.is.null,story_id.is.null");
        filters.push((r) => r.embedding === null || r.story_id === null);
        return q;
      },
      order(col: string) {
        expect(col).toBe("id");
        return q;
      },
      gt(col: string, value: string) {
        expect(col).toBe("id");
        filters.push((r) => r.id > value);
        return q;
      },
      limit(n: number) {
        limit = n;
        return q;
      },
      then(resolve: (v: unknown) => void) {
        const matched = rows.filter((r) => filters.every((f) => f(r))).sort((a, b) => (a.id < b.id ? -1 : 1));
        log.push(head ? "count" : "select");
        resolve(head ? { count: matched.length, error: null } : { data: matched.slice(0, limit).map((r) => ({ ...r })), error: null });
      },
    };
    return q;
  }

  function updateQuery(patch: Partial<Row>) {
    const filters: ((r: Row) => boolean)[] = [];
    let id = "";
    const q = {
      eq(col: string, value: string) {
        expect(col).toBe("id");
        id = value;
        filters.push((r) => r.id === value);
        return q;
      },
      is(col: keyof Row, value: null) {
        filters.push((r) => r[col] === value);
        return q;
      },
      select(cols: string) {
        expect(cols).toBe("id");
        return q;
      },
      then(resolve: (v: unknown) => void) {
        log.push(`update ${id} ${Object.keys(patch).sort().join(",")}`);
        if (opts.failUpdateFor?.has(id)) return resolve({ data: null, error: { message: "boom" } });
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        for (const r of hit) Object.assign(r, patch);
        resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
      },
    };
    return q;
  }

  const client = {
    from(table: string) {
      expect(table).toBe("cards");
      return {
        select: (_cols: string, o?: { head?: boolean }) => selectQuery(o?.head === true),
        update: (patch: Partial<Row>) => updateQuery(patch),
      };
    },
  };
  return { client: client as never, rows, log };
}

const vec = (seed: number) => Array.from({ length: 384 }, (_, i) => (i === seed ? 1 : 0));
const row = (id: string, extra: Partial<Row> = {}): Row => ({ id, title: `T ${id}`, short_summary: `S ${id}.`, embedding: null, story_id: null, ...extra });

describe("backfill-card-embeddings", () => {
  it("embeds the same text the digest run does", () => {
    for (const [t, s] of [
      ["Talks open", "Negotiators met."],
      ["  padded  ", " text "],
      ["", "No title."],
      ["x".repeat(900), "y".repeat(900)],
    ]) {
      expect(scriptStoryText(t, s)).toBe(storyText(t, s));
    }
  });

  it("embeds with the same model and settings as the app", async () => {
    const texts = ["Ceasefire talks open in Doha. Negotiators met.", "Real Madrid beat Sevilla 2-1."];
    const [ours, app] = await Promise.all([embedLocally(texts), embed(texts)]);
    expect(ours).toHaveLength(2);
    ours.forEach((v, i) => {
      expect(v).toHaveLength(384);
      v.forEach((x, j) => expect(x).toBeCloseTo(app[i][j], 6));
    });
  }, 60_000);

  it("only counts on a dry run", async () => {
    const { client, rows, log } = fakeCards([row("a"), row("b", { story_id: "b" }), row("c", { embedding: vec(1), story_id: "c" })]);
    const embedFn = vi.fn();
    const lines: string[] = [];
    const counts = await backfill({ client, embed: embedFn, write: false, log: (l) => lines.push(l) });
    expect(counts).toEqual({ missingEmbedding: 2, missingStory: 1, updated: 0, skipped: 0, failed: 0 });
    expect(embedFn).not.toHaveBeenCalled();
    expect(log).toEqual(["count", "count"]);
    expect(rows[0]).toMatchObject({ embedding: null, story_id: null });
    expect(lines.join("\n")).toMatch(/2 card\(s\) have no embedding; 1 have no story/);
    expect(lines.join("\n")).toMatch(/--write/);
  });

  it("fills every missing embedding and story, in batches, embedding only what lacks one", async () => {
    const initial = [
      row("a"),
      row("b", { story_id: "S" }),
      row("c", { embedding: vec(3) }),
      row("d", { embedding: vec(4), story_id: "d" }),
      row("e", { title: null, short_summary: "Only a summary." }),
    ];
    const { client, rows } = fakeCards(initial);
    const embedFn = vi.fn(async (texts: string[]) => texts.map((_, i) => vec(10 + i)));
    const counts = await backfill({ client, embed: embedFn, write: true, batchSize: 2 });

    expect(counts).toMatchObject({ missingEmbedding: 3, missingStory: 3, updated: 4, failed: 0 });
    expect(embedFn.mock.calls.flat(2)).toEqual(["T a. S a.", "T b. S b.", "Only a summary."]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.a.story_id).toBe("a");
    expect(byId.b.story_id).toBe("S");
    expect(byId.c).toMatchObject({ embedding: vec(3), story_id: "c" });
    expect(byId.d).toEqual(initial[3]);
    expect(rows.every((r) => r.embedding?.length === 384 && r.story_id !== null)).toBe(true);
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    const { client, log } = fakeCards([row("a"), row("b")]);
    const embedFn = vi.fn(async (texts: string[]) => texts.map(() => vec(1)));
    await backfill({ client, embed: embedFn, write: true });
    log.length = 0;
    embedFn.mockClear();
    const again = await backfill({ client, embed: embedFn, write: true });
    expect(again).toEqual({ missingEmbedding: 0, missingStory: 0, updated: 0, skipped: 0, failed: 0 });
    expect(embedFn).not.toHaveBeenCalled();
    expect(log.filter((l) => l.startsWith("update"))).toEqual([]);
  });

  it("never overwrites a value written since it read the card", async () => {
    const { client, rows } = fakeCards([row("a")]);
    const embedFn = vi.fn(async (texts: string[]) => {
      // The new code saves this card meanwhile.
      Object.assign(rows[0], { embedding: vec(7), story_id: "S" });
      return texts.map(() => vec(1));
    });
    const counts = await backfill({ client, embed: embedFn, write: true });
    expect(rows[0]).toMatchObject({ embedding: vec(7), story_id: "S" });
    expect(counts).toMatchObject({ updated: 0, skipped: 1, failed: 0 });
  });

  it("counts a failed update, carries on, and doesn't read the same card again", async () => {
    const { client, rows, log } = fakeCards([row("a"), row("b"), row("c")], { failUpdateFor: new Set(["b"]) });
    const counts = await backfill({ client, embed: async (t) => t.map(() => vec(1)), write: true, batchSize: 2 });
    expect(counts).toMatchObject({ updated: 2, failed: 1 });
    expect(rows.find((r) => r.id === "b")?.embedding).toBeNull();
    expect(log.filter((l) => l === "update b embedding,story_id")).toHaveLength(1);
  });

  it("skips a vector that isn't 384 numbers but still sets the story", async () => {
    const { client, rows } = fakeCards([row("a")]);
    await backfill({ client, embed: async () => [[1, 2, 3]], write: true });
    expect(rows[0]).toMatchObject({ embedding: null, story_id: "a" });
  });
});
