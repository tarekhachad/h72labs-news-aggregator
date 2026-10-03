import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SOURCES, TOPICS } from "@/types";
import {
  MAX_TOPICS,
  MIN_TOPICS,
  ProfileInput,
  getUserProfile,
  saveUserProfile,
} from "@/lib/profile";

// Topics are 3 to 10 distinct picks and sources are optional. Every name
// here comes from TOPICS/SOURCES by position: the catalog is growing and
// being renamed, so a hard-coded topic name would break on the next edit.

const topics = (n: number) => TOPICS.slice(0, n);

describe("ProfileInput limits", () => {
  it("allows a catalog large enough to test the maximum", () => {
    expect(TOPICS.length).toBeGreaterThan(MAX_TOPICS);
    expect([MIN_TOPICS, MAX_TOPICS]).toEqual([3, 10]);
  });

  it("rejects 2 topics with the minimum message", () => {
    const parsed = ProfileInput.safeParse({ topics: topics(2), preferredSources: [] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Pick at least 3 topics");
  });

  it("accepts exactly 3 topics", () => {
    const parsed = ProfileInput.safeParse({ topics: topics(3), preferredSources: [] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.topics).toEqual(topics(3));
  });

  it("accepts exactly 10 topics", () => {
    const parsed = ProfileInput.safeParse({ topics: topics(10), preferredSources: [] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.topics).toEqual(topics(10));
  });

  it("rejects 11 topics with the maximum message", () => {
    const parsed = ProfileInput.safeParse({ topics: topics(11), preferredSources: [] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Pick at most 10 topics");
  });

  it("counts distinct topics, so a repeated pick can't make up the third", () => {
    const [a, b] = topics(2);
    const parsed = ProfileInput.safeParse({ topics: [a, b, a], preferredSources: [] });
    expect(parsed.success).toBe(false);
  });

  it("counts distinct topics, so 10 picks plus a repeat still pass", () => {
    const ten = topics(10);
    const parsed = ProfileInput.safeParse({ topics: [...ten, ten[0]], preferredSources: [] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.topics).toEqual(ten);
  });

  it("accepts zero preferred sources", () => {
    const parsed = ProfileInput.safeParse({ topics: topics(3), preferredSources: [] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.preferredSources).toEqual([]);
  });

  it("still rejects an unknown topic or source", () => {
    expect(
      ProfileInput.safeParse({ topics: [...topics(3), "Not A Topic"], preferredSources: [] }).success
    ).toBe(false);
    expect(
      ProfileInput.safeParse({ topics: topics(3), preferredSources: ["Not A Source"] }).success
    ).toBe(false);
  });
});

// An in-memory stand-in for the two preference tables, implementing only the
// calls saveUserProfile and getUserProfile make. The empty-insert guard is the
// thing under test, so `insert` refuses an empty array outright: if the guard
// were removed, the round trip below would fail instead of quietly passing
// on whatever PostgREST might do with an empty body.
function makeTableFake(initial: { user_topics?: string[]; user_preferred_sources?: string[] } = {}) {
  const userId = "user-1";
  const tables: Record<string, Array<Record<string, string>>> = {
    user_topics: (initial.user_topics ?? []).map((topic) => ({ user_id: userId, topic })),
    user_preferred_sources: (initial.user_preferred_sources ?? []).map((source) => ({
      user_id: userId,
      source,
    })),
  };
  const insert = vi.fn();

  const from = (table: string) => {
    if (table === "user_settings") {
      const chain = {
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return { select: () => chain };
    }
    const rows = tables[table];
    if (!rows) throw new Error(`fake supabase: unexpected table ${table}`);
    return {
      delete: () => ({
        eq: (key: string, value: string) => {
          tables[table] = rows.filter((row) => row[key] !== value);
          return Promise.resolve({ error: null });
        },
      }),
      insert: (newRows: Array<Record<string, string>>) => {
        insert(table, newRows);
        if (newRows.length === 0) {
          return Promise.resolve({ error: { message: "empty insert reached the database" } });
        }
        tables[table].push(...newRows);
        return Promise.resolve({ error: null });
      },
      select: (column: string) => ({
        eq: (key: string, value: string) =>
          Promise.resolve({
            data: tables[table]
              .filter((row) => row[key] === value)
              .map((row) => ({ [column]: row[column] })),
            error: null,
          }),
      }),
    };
  };

  return { client: { from } as unknown as SupabaseClient, insert, userId };
}

describe("saveUserProfile with zero sources", () => {
  it("saves zero sources without inserting, and reads them back as none", async () => {
    const { client, insert, userId } = makeTableFake({
      user_topics: topics(4),
      user_preferred_sources: SOURCES.slice(0, 2),
    });

    await expect(saveUserProfile(client, userId, topics(3), [])).resolves.toEqual({ error: null });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      "user_topics",
      topics(3).map((topic) => ({ user_id: userId, topic }))
    );

    const profile = await getUserProfile(client, userId);
    expect(profile.topics).toEqual(topics(3));
    expect(profile.preferredSources).toEqual([]);
  });

  it("still inserts sources when there are some", async () => {
    const { client, insert, userId } = makeTableFake();
    const sources = SOURCES.slice(0, 2);

    await expect(saveUserProfile(client, userId, topics(3), sources)).resolves.toEqual({
      error: null,
    });

    expect(insert).toHaveBeenCalledWith(
      "user_preferred_sources",
      sources.map((source) => ({ user_id: userId, source }))
    );
    expect((await getUserProfile(client, userId)).preferredSources).toEqual(sources);
  });
});

describe("getUserProfile with more than the maximum saved", () => {
  it("loads every saved topic, with no cap applied on read", async () => {
    const saved = topics(MAX_TOPICS + 3);
    const { client, userId } = makeTableFake({ user_topics: saved });

    expect((await getUserProfile(client, userId)).topics).toEqual(saved);
  });
});
