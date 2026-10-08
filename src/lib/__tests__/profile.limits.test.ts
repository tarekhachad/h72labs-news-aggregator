import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SOURCES, TOPICS } from "@/types";

// COUNTRIES is empty until the country catalog lands.
vi.mock("@/config/countries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/countries")>()),
  COUNTRIES: ["Uganda", "Kenya", "Morocco", "Ghana"],
}));
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

// An in-memory stand-in for the three preference tables, implementing only the
// calls saveUserProfile and getUserProfile make. The empty-insert guard is the
// thing under test, so `insert` refuses an empty array outright: if the guard
// were removed, the round trip below would fail instead of quietly passing
// on whatever PostgREST might do with an empty body.
function makeTableFake(
  initial: {
    user_topics?: string[];
    user_preferred_sources?: string[];
    user_subtopics?: Array<{ topic: string; subtopic: string }>;
  } = {}
) {
  const userId = "user-1";
  const tables: Record<string, Array<Record<string, string>>> = {
    user_topics: (initial.user_topics ?? []).map((topic) => ({ user_id: userId, topic })),
    user_preferred_sources: (initial.user_preferred_sources ?? []).map((source) => ({
      user_id: userId,
      source,
    })),
    user_subtopics: (initial.user_subtopics ?? []).map((row) => ({ user_id: userId, ...row })),
  };
  // A filter chain that is also awaitable, so `.eq(a).eq(b)` narrows like
  // PostgREST does and awaiting it runs the operation on what matched.
  const filtered = <T>(run: (match: (row: Record<string, string>) => boolean) => T) => {
    const conditions: Array<[string, string]> = [];
    const match = (row: Record<string, string>) => conditions.every(([k, v]) => row[k] === v);
    const chain = {
      eq: (key: string, value: string) => {
        conditions.push([key, value]);
        return chain;
      },
      then: (resolve: (v: T) => unknown) => Promise.resolve(run(match)).then(resolve),
    };
    return chain;
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
      delete: () =>
        filtered((match) => {
          tables[table] = tables[table].filter((row) => !match(row));
          return { error: null };
        }),
      insert: (newRows: Array<Record<string, string>>) => {
        insert(table, newRows);
        if (newRows.length === 0) {
          return Promise.resolve({ error: { message: "empty insert reached the database" } });
        }
        tables[table].push(...newRows);
        return Promise.resolve({ error: null });
      },
      select: (column: string) =>
        filtered((match) => ({
          data: tables[table].filter(match).map((row) => ({ [column]: row[column] })),
          error: null,
        })),
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

    await expect(saveUserProfile(client, userId, topics(3), [], [])).resolves.toEqual({ error: null });

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

    await expect(saveUserProfile(client, userId, topics(3), sources, [])).resolves.toEqual({
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

// Countries count as reading units: the Countries topic itself counts as
// nothing, each picked country as one. The reader never picks the topic: it
// is saved exactly when a country is.
describe("ProfileInput with countries", () => {
  const nonCountry = TOPICS.filter((t) => t !== "Countries");
  const parse = (picked: readonly string[], countries?: string[]) =>
    ProfileInput.safeParse({ topics: picked, preferredSources: [], countries });

  it("accepts a form with no countries field at all, as before", () => {
    const parsed = ProfileInput.safeParse({ topics: nonCountry.slice(0, 3), preferredSources: [] });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.countries).toEqual([]);
  });

  it("accepts 2 topics plus Countries with one country: 3 units", () => {
    const parsed = parse([...nonCountry.slice(0, 2), "Countries"], ["Kenya"]);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.countries).toEqual(["Kenya"]);
    expect(parsed.data?.topics).toEqual([...nonCountry.slice(0, 2), "Countries"]);
  });

  it("accepts Countries alone with 3 countries", () => {
    expect(parse(["Countries"], ["Kenya", "Uganda", "Ghana"]).success).toBe(true);
  });

  it("saves no Countries topic when Countries is sent with no country", () => {
    const parsed = parse([...nonCountry.slice(0, 3), "Countries"], []);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.topics).toEqual(nonCountry.slice(0, 3));
    expect(parsed.data?.countries).toEqual([]);
  });

  it("adds the Countries topic when countries come without it, after the picked topics", () => {
    const parsed = parse(nonCountry.slice(0, 2), ["Kenya"]);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.topics).toEqual([...nonCountry.slice(0, 2), "Countries"]);
    expect(parsed.data?.countries).toEqual(["Kenya"]);
  });

  it("ignores where Countries was sent among the topics, and sends it once", () => {
    const parsed = parse(["Countries", nonCountry[0], "Countries", nonCountry[1]], ["Kenya"]);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.topics).toEqual([nonCountry[0], nonCountry[1], "Countries"]);
  });

  it("rejects 1 topic plus Countries with one country: 2 units, with a message that counts countries", () => {
    const parsed = parse([nonCountry[0], "Countries"], ["Kenya"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "Pick at least 3 topics and countries (each country counts as one)"
    );
  });

  it("accepts 6 topics plus 4 countries: exactly 10 units", () => {
    const parsed = parse([...nonCountry.slice(0, 6), "Countries"], ["Kenya", "Uganda", "Ghana", "Morocco"]);
    expect(parsed.success).toBe(true);
  });

  it("rejects 8 topics plus 3 countries: 11 units", () => {
    const parsed = parse([...nonCountry.slice(0, 8), "Countries"], ["Kenya", "Uganda", "Ghana"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "Pick at most 10 topics and countries (each country counts as one)"
    );
  });

  it("counts a repeated country once", () => {
    const parsed = parse([nonCountry[0], "Countries"], ["Kenya", "Kenya", "Uganda"]);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.countries).toEqual(["Kenya", "Uganda"]);
  });

  it("rejects an unknown country sent without the Countries topic", () => {
    const parsed = parse(nonCountry.slice(0, 3), ["Kenya", "Atlantis"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Atlantis isn't a country you can pick");
  });

  it("counts countries sent without the Countries topic toward the limits", () => {
    expect(parse(nonCountry.slice(0, 2), ["Kenya", "Uganda"]).success).toBe(true);
    const over = parse(nonCountry.slice(0, 9), ["Kenya", "Uganda"]);
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe(
      "Pick at most 10 topics and countries (each country counts as one)"
    );
  });

  it("keeps the plain-topics message when no country is picked", () => {
    const parsed = parse([nonCountry[0], nonCountry[1], "Countries"], []);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Pick at least 3 topics");
  });

  it("rejects a country not on offer when Countries is picked", () => {
    const parsed = parse([...nonCountry.slice(0, 2), "Countries"], ["Atlantis"]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Atlantis isn't a country you can pick");
  });

  it("rejects a non-string countries entry", () => {
    const parsed = parse([...nonCountry.slice(0, 2), "Countries"], [new File([], "x") as unknown as string]);
    expect(parsed.success).toBe(false);
  });
});

describe("saveUserProfile with countries", () => {
  it("replaces the saved Countries rows and reads them back in curated order", async () => {
    const { client, insert, userId } = makeTableFake({
      user_topics: ["Countries", TOPICS[0]],
      user_subtopics: [{ topic: "Countries", subtopic: "Ghana" }],
    });
    const picked = [TOPICS[0], TOPICS[1], "Countries"] as typeof TOPICS[number][];

    await expect(saveUserProfile(client, userId, picked, [], ["Morocco", "Uganda"])).resolves.toEqual({
      error: null,
    });

    expect(insert).toHaveBeenCalledWith("user_subtopics", [
      { user_id: userId, topic: "Countries", subtopic: "Morocco" },
      { user_id: userId, topic: "Countries", subtopic: "Uganda" },
    ]);
    expect((await getUserProfile(client, userId)).countries).toEqual(["Uganda", "Morocco"]);
  });

  it("clears saved countries without an empty insert when none are picked", async () => {
    const { client, insert, userId } = makeTableFake({
      user_topics: ["Countries"],
      user_subtopics: [{ topic: "Countries", subtopic: "Ghana" }],
    });

    await expect(saveUserProfile(client, userId, topics(3), [], [])).resolves.toEqual({ error: null });

    expect(insert).not.toHaveBeenCalledWith("user_subtopics", expect.anything());
    expect((await getUserProfile(client, userId)).countries).toEqual([]);
  });

  it("leaves another topic's subtopics alone", async () => {
    const { client, userId } = makeTableFake({
      user_subtopics: [
        { topic: "Countries", subtopic: "Ghana" },
        { topic: "Football", subtopic: "Premier League" },
      ],
    });

    await saveUserProfile(client, userId, topics(3), [], []);

    // Read back through a Football-scoped select on the same fake.
    const rows = await (client.from("user_subtopics").select("subtopic") as unknown as {
      eq: (k: string, v: string) => { eq: (k: string, v: string) => PromiseLike<{ data: unknown }> };
    })
      .eq("user_id", userId)
      .eq("topic", "Football");
    expect(rows.data).toEqual([{ subtopic: "Premier League" }]);
  });
});
