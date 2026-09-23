import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserProfile } from "@/lib/profile";

// profile.ts had no tests at all before this file, and all seven route
// wiring tests vi.mock the module wholesale — so nothing anywhere exercised
// the real getUserProfile.
//
// The behavior under test is ORDER, which means every assertion here has to
// be a deep equality against a full expected array. Set-membership or
// toContain assertions would pass against the unordered implementation this
// file exists to rule out.
//
// The fake blends two house patterns: dispatch on the from(table) argument
// (per digests.latestGeneratedAt.corruption.test.ts) so the two concurrent
// Promise.all queries get their own datasets, and a thenable terminal (per
// digests.listDigestDates.test.ts) because getUserProfile awaits
// .from().select().eq() with no terminal method to resolve it.

interface TableResponse {
  data: unknown;
  error: { message: string } | null;
}

function makeFakeSupabase(responses: {
  user_topics?: Partial<TableResponse>;
  user_preferred_sources?: Partial<TableResponse>;
  /** Omitted means the user has no settings row, the state before TimeZoneSync first writes one. */
  user_settings?: Partial<TableResponse>;
}) {
  const eq = vi.fn();
  const select = vi.fn();

  const from = vi.fn((table: string) => {
    const configured =
      table === "user_topics"
        ? responses.user_topics
        : table === "user_preferred_sources"
          ? responses.user_preferred_sources
          : table === "user_settings"
            ? (responses.user_settings ?? { data: null })
            : undefined;
    if (configured === undefined) {
      throw new Error(`fake supabase: unexpected table ${table}`);
    }
    // `?? []` would be wrong here: it coerces an explicitly-passed null into
    // [] before getUserProfile ever sees it, which silently defeats the null
    // case below — production's own `?? []` guard could be deleted and this
    // file would still pass. Default only a genuinely ABSENT key.
    const response: TableResponse = {
      data: configured.data === undefined ? [] : configured.data,
      error: configured.error ?? null,
    };

    // Chainable and thenable: `await supabase.from(t).select(c).eq(k, v)`
    // resolves to the response without any terminal method being called.
    const chain = {
      eq: (...args: unknown[]) => {
        eq(table, ...args);
        return chain;
      },
      // getUserTimeZone ends in maybeSingle(); the list reads await the chain.
      maybeSingle: () => Promise.resolve(response),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(response).then(resolve),
    };
    return {
      select: (...args: unknown[]) => {
        select(table, ...args);
        return chain;
      },
    };
  });

  return { client: { from } as unknown as SupabaseClient, from, select, eq };
}

const topicRows = (...topics: string[]) => topics.map((topic) => ({ topic }));
const sourceRows = (...sources: string[]) => sources.map((source) => ({ source }));

describe("getUserProfile", () => {
  it("returns topics in curated order regardless of the order the DB hands them back", async () => {
    // The case that fails against an unordered map/filter implementation.
    const { client } = makeFakeSupabase({
      user_topics: { data: topicRows("Tennis", "Tech/AI", "Morocco", "US Politics") },
      user_preferred_sources: { data: sourceRows("NYT") },
    });

    const profile = await getUserProfile(client, "user-1");

    expect(profile.topics).toEqual(["Tech/AI", "US Politics", "Morocco", "Tennis"]);
  });

  it("orders by the curated list, not alphabetically", async () => {
    // Guards the design choice itself: this also fails against a
    // .order("topic") implementation, so a later "simplification" to sorting
    // in SQL can't land silently. Alphabetical would be
    // American Football, Tech/AI, Tennis.
    const { client } = makeFakeSupabase({
      user_topics: { data: topicRows("Tennis", "American Football", "Tech/AI") },
      user_preferred_sources: { data: sourceRows("NYT") },
    });

    const profile = await getUserProfile(client, "user-1");

    expect(profile.topics).toEqual(["Tech/AI", "Tennis", "American Football"]);
  });

  it("returns the same result for the same set of rows in two different DB orders", async () => {
    // States the invariant rather than one instance of it: the function's
    // output must be a function of the row SET, not of row order.
    const forward = makeFakeSupabase({
      user_topics: { data: topicRows("Tech/AI", "Geopolitics", "US Finance") },
      user_preferred_sources: { data: sourceRows("BBC", "NYT") },
    });
    const reversed = makeFakeSupabase({
      user_topics: { data: topicRows("US Finance", "Geopolitics", "Tech/AI") },
      user_preferred_sources: { data: sourceRows("NYT", "BBC") },
    });

    const first = await getUserProfile(forward.client, "user-1");
    const second = await getUserProfile(reversed.client, "user-1");

    expect(first).toEqual(second);
    expect(first.topics).toEqual(["Tech/AI", "Geopolitics", "US Finance"]);
  });

  it("applies the same curated ordering to preferredSources", async () => {
    // Pins the uniformity decision. Also not alphabetical — that would be
    // BBC, NYT, TechCrunch.
    const { client } = makeFakeSupabase({
      user_topics: { data: topicRows("Tech/AI") },
      user_preferred_sources: { data: sourceRows("TechCrunch", "NYT", "BBC") },
    });

    const profile = await getUserProfile(client, "user-1");

    expect(profile.preferredSources).toEqual(["NYT", "BBC", "TechCrunch"]);
  });

  it("drops a stored value no longer in the curated list without disturbing order", async () => {
    const { client } = makeFakeSupabase({
      user_topics: { data: topicRows("Tennis", "Cricket", "Tech/AI") },
      user_preferred_sources: { data: sourceRows("NYT", "Teletext") },
    });

    const profile = await getUserProfile(client, "user-1");

    expect(profile.topics).toEqual(["Tech/AI", "Tennis"]);
    expect(profile.preferredSources).toEqual(["NYT"]);
  });

  it("returns empty arrays for empty and for null data", async () => {
    // The `?? []` is load-bearing: an empty profile is what redirects a user
    // to /onboarding, so a null here must not become a crash.
    const empty = makeFakeSupabase({
      user_topics: { data: [] },
      user_preferred_sources: { data: [] },
    });
    const nulls = makeFakeSupabase({
      user_topics: { data: null },
      user_preferred_sources: { data: null },
    });

    await expect(getUserProfile(empty.client, "user-1")).resolves.toEqual({
      topics: [],
      preferredSources: [],
      timeZone: "UTC",
    });
    await expect(getUserProfile(nulls.client, "user-1")).resolves.toEqual({
      topics: [],
      preferredSources: [],
      timeZone: "UTC",
    });
  });

  it("collapses duplicate rows", async () => {
    // Impossible today under the composite (user_id, topic) primary key, but
    // free under a curated-list walk and worth pinning as intentional rather
    // than incidental.
    const { client } = makeFakeSupabase({
      user_topics: { data: topicRows("Tech/AI", "Tech/AI", "Tennis") },
      user_preferred_sources: { data: sourceRows("NYT", "NYT") },
    });

    const profile = await getUserProfile(client, "user-1");

    expect(profile.topics).toEqual(["Tech/AI", "Tennis"]);
    expect(profile.preferredSources).toEqual(["NYT"]);
  });

  it("throws on a query error rather than looking like an empty profile", async () => {
    // A transient failure must not be indistinguishable from "user has no
    // preferences" — that would bounce an onboarded user back to /onboarding.
    const topicFailure = makeFakeSupabase({
      user_topics: { data: null, error: { message: "boom" } },
      user_preferred_sources: { data: sourceRows("NYT") },
    });
    const sourceFailure = makeFakeSupabase({
      user_topics: { data: topicRows("Tech/AI") },
      user_preferred_sources: { data: null, error: { message: "kaboom" } },
    });
    const bothFailed = makeFakeSupabase({
      user_topics: { data: null, error: { message: "topics down" } },
      user_preferred_sources: { data: null, error: { message: "sources down" } },
    });

    await expect(getUserProfile(topicFailure.client, "user-1")).rejects.toThrow(
      "getUserProfile: failed to load topics: boom"
    );
    await expect(getUserProfile(sourceFailure.client, "user-1")).rejects.toThrow(
      "getUserProfile: failed to load sources: kaboom"
    );
    // Topics are checked first, so that error is the one that surfaces.
    await expect(getUserProfile(bothFailed.client, "user-1")).rejects.toThrow(
      "getUserProfile: failed to load topics: topics down"
    );
  });

  it("queries both preference tables scoped to the given user", async () => {
    const { client, from, select, eq } = makeFakeSupabase({
      user_topics: { data: topicRows("Tech/AI") },
      user_preferred_sources: { data: sourceRows("NYT") },
    });

    await getUserProfile(client, "user-42");

    expect(from).toHaveBeenCalledWith("user_topics");
    expect(from).toHaveBeenCalledWith("user_preferred_sources");
    expect(select).toHaveBeenCalledWith("user_topics", "topic");
    expect(select).toHaveBeenCalledWith("user_preferred_sources", "source");
    expect(eq).toHaveBeenCalledWith("user_topics", "user_id", "user-42");
    expect(eq).toHaveBeenCalledWith("user_preferred_sources", "user_id", "user-42");
  });

  it("returns the stored timezone", async () => {
    const { client, eq } = makeFakeSupabase({
      user_topics: { data: topicRows("Tech/AI") },
      user_preferred_sources: { data: sourceRows("NYT") },
      user_settings: { data: { time_zone: "Africa/Casablanca" } },
    });

    const profile = await getUserProfile(client, "user-1");

    expect(profile.timeZone).toBe("Africa/Casablanca");
    expect(eq).toHaveBeenCalledWith("user_settings", "user_id", "user-1");
  });

  it("uses UTC when the user has no settings row yet", async () => {
    const { client } = makeFakeSupabase({
      user_topics: { data: topicRows("Tech/AI") },
      user_preferred_sources: { data: sourceRows("NYT") },
    });

    expect((await getUserProfile(client, "user-1")).timeZone).toBe("UTC");
  });

  it("degrades a failed settings read to UTC instead of failing the profile", async () => {
    // Unlike topics and sources: a wrong zone files at most one run under the
    // UTC date, while a throw here would take down every page that loads a
    // profile.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeFakeSupabase({
      user_topics: { data: topicRows("Tech/AI") },
      user_preferred_sources: { data: sourceRows("NYT") },
      user_settings: { data: null, error: { message: "settings down" } },
    });

    const profile = await getUserProfile(client, "user-1");

    expect(profile.timeZone).toBe("UTC");
    expect(profile.topics).toEqual(["Tech/AI"]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
