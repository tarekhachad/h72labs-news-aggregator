import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SOURCES, TOPICS } from "@/types";
import { MAX_TOPICS, MIN_TOPICS, ProfileInput, saveUserProfile } from "@/lib/profile";

// QA edges for the 3-to-10 topic rule, optional sources, and the empty
// sources insert guard's error paths. Names are TOPICS/SOURCES by position.

const topics = (n: number) => TOPICS.slice(0, n);

describe("ProfileInput edges", () => {
  it("zero topics fails with the minimum message", () => {
    const parsed = ProfileInput.safeParse({ topics: [], preferredSources: [] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(`Pick at least ${MIN_TOPICS} topics`);
  });

  it("many duplicates of 3 distinct topics pass, deduped in first-seen order", () => {
    const [a, b, c] = topics(3);
    const parsed = ProfileInput.safeParse({
      topics: [c, a, c, b, a, c, b, a, c, b, a, c, b],
      preferredSources: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.topics).toEqual([c, a, b]);
  });

  it(`${MAX_TOPICS + 1} distinct picks fail even when mixed with repeats`, () => {
    const eleven = topics(MAX_TOPICS + 1);
    const parsed = ProfileInput.safeParse({
      topics: [...eleven, ...eleven],
      preferredSources: [],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(`Pick at most ${MAX_TOPICS} topics`);
  });

  it("duplicate sources dedupe and have no limit", () => {
    const all = [...SOURCES];
    const parsed = ProfileInput.safeParse({ topics: topics(3), preferredSources: [...all, ...all] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.preferredSources).toEqual(all);
  });

  it("a non-string FormData entry (a File) is rejected, not coerced", () => {
    const parsed = ProfileInput.safeParse({
      topics: [...topics(3), new Blob(["x"])],
      preferredSources: [],
    });
    expect(parsed.success).toBe(false);
  });
});

type Call = { op: string; table: string; rows?: unknown[] };

// Every step's outcome is scripted, so each error path can be hit on its own.
function scripted(fail: { deleteTopics?: boolean; deleteSources?: boolean; insertTopics?: boolean; insertSources?: boolean } = {}) {
  const calls: Call[] = [];
  const err = { message: "boom" };
  const from = vi.fn((table: string) => ({
    delete: () => ({
      eq: () => {
        calls.push({ op: "delete", table });
        const failed = table === "user_topics" ? fail.deleteTopics : fail.deleteSources;
        return Promise.resolve({ error: failed ? err : null });
      },
    }),
    insert: (rows: unknown[]) => {
      calls.push({ op: "insert", table, rows });
      const failed = table === "user_topics" ? fail.insertTopics : fail.insertSources;
      return Promise.resolve({ error: failed ? err : null });
    },
  }));
  return { client: { from } as unknown as SupabaseClient, calls };
}

const FAIL = { error: "Couldn't save your preferences — try again." };

describe("saveUserProfile error paths around the empty-sources guard", () => {
  it("zero sources: a topics insert failure is still reported", async () => {
    const { client, calls } = scripted({ insertTopics: true });
    await expect(saveUserProfile(client, "u", topics(3), [])).resolves.toEqual(FAIL);
    expect(calls.filter((c) => c.op === "insert").map((c) => c.table)).toEqual(["user_topics"]);
  });

  it("zero sources: a failed sources delete stops before any insert", async () => {
    const { client, calls } = scripted({ deleteSources: true });
    await expect(saveUserProfile(client, "u", topics(3), [])).resolves.toEqual(FAIL);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("zero sources: the sources table is still cleared (old picks don't linger)", async () => {
    const { client, calls } = scripted();
    await expect(saveUserProfile(client, "u", topics(3), [])).resolves.toEqual({ error: null });
    expect(calls).toContainEqual({ op: "delete", table: "user_preferred_sources" });
  });

  it("some sources: a sources insert failure is reported", async () => {
    const { client } = scripted({ insertSources: true });
    await expect(saveUserProfile(client, "u", topics(3), [SOURCES[0]])).resolves.toEqual(FAIL);
  });

  it("one source is inserted, not skipped (the guard is exactly zero)", async () => {
    const { client, calls } = scripted();
    await saveUserProfile(client, "u", topics(3), [SOURCES[1]]);
    expect(calls).toContainEqual({
      op: "insert",
      table: "user_preferred_sources",
      rows: [{ user_id: "u", source: SOURCES[1] }],
    });
  });
});
