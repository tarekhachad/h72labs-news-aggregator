import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TOPICS, type Topic } from "@/types";

vi.mock("@/config/countries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/countries")>()),
  COUNTRIES: ["Uganda", "Kenya", "Morocco", "Ghana", "Côte d'Ivoire"],
}));

import * as profile from "@/lib/profile";
import { MAX_TOPICS, MIN_TOPICS, ProfileInput, getUserProfile, saveUserProfile } from "@/lib/profile";

const plain = TOPICS.filter((t) => t !== "Countries") as Topic[];
const parse = (topics: readonly unknown[], countries?: unknown[], preferredSources: unknown[] = []) =>
  ProfileInput.safeParse(
    countries === undefined ? { topics, preferredSources } : { topics, preferredSources, countries }
  );
const msg = (r: ReturnType<typeof parse>) => (r.success ? null : r.error.issues[0]?.message);

describe("QA: ProfileInput exports and zero-countries invariant", () => {
  it("still exports MIN_TOPICS = 3 and MAX_TOPICS = 10", () => {
    expect(profile.MIN_TOPICS).toBe(3);
    expect(profile.MAX_TOPICS).toBe(10);
    expect(MIN_TOPICS).toBe(3);
    expect(MAX_TOPICS).toBe(10);
  });

  it.each([0, 1, 2])("plain %i topics: same minimum message as before", (n) => {
    expect(msg(parse(plain.slice(0, n)))).toBe("Pick at least 3 topics");
    expect(msg(parse(plain.slice(0, n), []))).toBe("Pick at least 3 topics");
  });

  it.each([11, 12])("plain %i topics: same maximum message as before", (n) => {
    expect(msg(parse(plain.slice(0, n)))).toBe("Pick at most 10 topics");
  });

  it.each([3, 7, 10])("plain %i topics parse to {topics, sources, countries: []}", (n) => {
    const r = parse(plain.slice(0, n), undefined, ["BBC"]);
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ topics: plain.slice(0, n), preferredSources: ["BBC"], countries: [] });
  });

  it("an unknown topic is still refused before any count", () => {
    expect(parse(["Nope", ...plain.slice(0, 3)]).success).toBe(false);
  });
});

describe("QA: ProfileInput country edge cases", () => {
  it("boundary: Countries alone with 2 countries (2 units) is refused with the counted message", () => {
    expect(msg(parse(["Countries"], ["Kenya", "Uganda"]))).toBe(
      "Pick at least 3 topics and countries (each country counts as one)"
    );
  });

  it("boundary: 9 plain + Countries + 1 country = 10 units passes; + 2 countries = 11 is refused", () => {
    expect(parse([...plain.slice(0, 9), "Countries"], ["Kenya"]).success).toBe(true);
    expect(msg(parse([...plain.slice(0, 9), "Countries"], ["Kenya", "Ghana"]))).toBe(
      "Pick at most 10 topics and countries (each country counts as one)"
    );
  });

  it("10 plain topics + Countries + 1 country is 11 units: refused", () => {
    expect(msg(parse([...plain.slice(0, 10), "Countries"], ["Kenya"]))).toBe(
      "Pick at most 10 topics and countries (each country counts as one)"
    );
  });

  it("10 plain topics + Countries with NO country: the 10 topics save, without Countries", () => {
    const r = parse([...plain.slice(0, 10), "Countries"], []);
    expect(r.success).toBe(true);
    expect(r.data?.topics).toEqual(plain.slice(0, 10));
  });

  it("a repeated Countries topic is counted once and countries still count", () => {
    const r = parse(["Countries", "Countries", plain[0]], ["Kenya", "Uganda"]);
    expect(r.success).toBe(true);
    expect(r.data?.topics).toEqual([plain[0], "Countries"]);
  });

  it("only duplicates of one country cannot make up the minimum", () => {
    expect(msg(parse(["Countries", plain[0]], ["Kenya", "Kenya", "Kenya"]))).toBe(
      "Pick at least 3 topics and countries (each country counts as one)"
    );
  });

  it("a non-ASCII offered country is accepted verbatim", () => {
    const r = parse(["Countries", plain[0], plain[1]], ["Côte d'Ivoire"]);
    expect(r.success).toBe(true);
    expect(r.data?.countries).toEqual(["Côte d'Ivoire"]);
  });

  it("matching is exact: wrong case and surrounding whitespace are refused", () => {
    expect(msg(parse(["Countries", plain[0], plain[1]], ["kenya"]))).toBe("kenya isn't a country you can pick");
    expect(parse(["Countries", plain[0], plain[1]], [" Kenya"]).success).toBe(false);
  });

  it("an unknown country mixed with valid ones is refused even when the count is fine", () => {
    expect(msg(parse(["Countries", plain[0]], ["Kenya", "Atlantis", "Uganda"]))).toBe(
      "Atlantis isn't a country you can pick"
    );
  });

  it("an empty-string country with Countries picked is refused", () => {
    const r = parse(["Countries", plain[0], plain[1]], [""]);
    expect(r.success).toBe(false);
    // QA finding (low): the message names an empty country.
    expect(msg(r)).toBe(" isn't a country you can pick");
  });

  it("prototype-ish names are not on offer", () => {
    expect(parse(["Countries", plain[0], plain[1]], ["constructor"]).success).toBe(false);
    expect(parse(["Countries", plain[0], plain[1]], ["__proto__"]).success).toBe(false);
  });

  it("countries: null (not an array) is refused rather than treated as none", () => {
    expect(parse(plain.slice(0, 3), null as unknown as unknown[]).success).toBe(false);
  });

  it("a File entry in countries WITHOUT the Countries topic is refused", () => {
    // QA finding (low): the element type is checked before the Countries
    // gate, so a non-string entry refuses a plain-topics save.
    const r = parse(plain.slice(0, 3), [new File([], "x")]);
    expect(r.success).toBe(false);
    expect(msg(r)).toBe("Invalid input: expected string, received File");
  });

  it("output countries keep first-seen order (save order), not curated order", () => {
    const r = parse(["Countries", plain[0]], ["Ghana", "Uganda", "Ghana"]);
    expect(r.data?.countries).toEqual(["Ghana", "Uganda"]);
  });
});

// In-memory fake for the preference tables, with a primary key on
// user_subtopics (user_id, topic, subtopic) so a duplicate insert fails the
// way Postgres would.
function fakeDb(seed: { topics?: string[]; sources?: string[]; subtopics?: { topic: string; subtopic: string; user_id?: string }[] } = {}) {
  const uid = "u1";
  const tables: Record<string, Record<string, string>[]> = {
    user_topics: (seed.topics ?? []).map((topic) => ({ user_id: uid, topic })),
    user_preferred_sources: (seed.sources ?? []).map((source) => ({ user_id: uid, source })),
    user_subtopics: (seed.subtopics ?? []).map((r) => ({ user_id: uid, ...r })),
  };
  const ops: string[] = [];
  const filtered = <T>(run: (m: (r: Record<string, string>) => boolean) => T) => {
    const conds: [string, string][] = [];
    const chain = {
      eq: (k: string, v: string) => {
        conds.push([k, v]);
        return chain;
      },
      then: (res: (v: T) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run((r) => conds.every(([k, v]) => r[k] === v))).then(res, rej),
    };
    return chain;
  };
  const from = (table: string) => {
    if (table === "user_settings") {
      const c = { eq: () => c, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
      return { select: () => c };
    }
    if (!tables[table]) throw new Error(`unexpected table ${table}`);
    return {
      delete: () =>
        filtered((m) => {
          ops.push(`delete ${table}`);
          tables[table] = tables[table].filter((r) => !m(r));
          return { error: null };
        }),
      insert: (rows: Record<string, string>[]) => {
        ops.push(`insert ${table} ${rows.length}`);
        if (rows.length === 0) return Promise.resolve({ error: { message: "empty insert" } });
        if (table === "user_subtopics") {
          const seen = new Set(tables[table].map((r) => `${r.user_id}|${r.topic}|${r.subtopic}`));
          for (const r of rows) {
            const k = `${r.user_id}|${r.topic}|${r.subtopic}`;
            if (seen.has(k)) return Promise.resolve({ error: { message: "duplicate key" } });
            seen.add(k);
          }
        }
        tables[table].push(...rows);
        return Promise.resolve({ error: null });
      },
      select: (col: string) =>
        filtered((m) => ({ data: tables[table].filter(m).map((r) => ({ [col]: r[col] })), error: null })),
    };
  };
  return { client: { from } as unknown as SupabaseClient, tables, ops, uid };
}

describe("QA: save/load round trips through ProfileInput", () => {
  async function saveViaForm(db: ReturnType<typeof fakeDb>, form: { topics: string[]; countries?: string[] }) {
    const parsed = ProfileInput.parse({ topics: form.topics, preferredSources: [], countries: form.countries });
    return saveUserProfile(db.client, db.uid, parsed.topics, parsed.preferredSources, parsed.countries);
  }

  it("duplicate countries in the form never reach the primary key", async () => {
    const db = fakeDb();
    await expect(
      saveViaForm(db, { topics: ["Countries", plain[0]], countries: ["Kenya", "Kenya", "Ghana"] })
    ).resolves.toEqual({ error: null });
    expect(db.tables.user_subtopics.map((r) => r.subtopic)).toEqual(["Kenya", "Ghana"]);
    const loaded = await getUserProfile(db.client, db.uid);
    expect(loaded.countries).toEqual(["Kenya", "Ghana"]);
    expect(loaded.topics).toContain("Countries");
  });

  it("re-saving the same countries succeeds (old rows deleted before insert)", async () => {
    const db = fakeDb();
    const form = { topics: ["Countries", plain[0]], countries: ["Kenya", "Uganda"] };
    await saveViaForm(db, form);
    await expect(saveViaForm(db, form)).resolves.toEqual({ error: null });
    expect(db.tables.user_subtopics).toHaveLength(2);
  });

  it("removing every country clears its rows and the Countries topic, and the load returns none", async () => {
    const db = fakeDb();
    await saveViaForm(db, { topics: [plain[0]], countries: ["Kenya", "Uganda"] });
    await saveViaForm(db, { topics: plain.slice(0, 3), countries: [] });
    expect(db.tables.user_subtopics).toEqual([]);
    expect(db.ops).not.toContain("insert user_subtopics 0");
    const loaded = await getUserProfile(db.client, db.uid);
    expect(loaded.countries).toEqual([]);
    expect(loaded.topics).not.toContain("Countries");
  });

  it("picking countries without Countries saves the topic with them", async () => {
    const db = fakeDb();
    await saveViaForm(db, { topics: [plain[0], plain[1]], countries: ["Ghana"] });
    expect(db.tables.user_topics.map((r) => r.topic).sort()).toEqual([plain[0], plain[1], "Countries"].sort());
    const loaded = await getUserProfile(db.client, db.uid);
    expect(loaded.topics).toContain("Countries");
    expect(loaded.countries).toEqual(["Ghana"]);
  });

  it("a profile saved with Countries and countries re-saves to the same rows from what the form sends", async () => {
    const db = fakeDb({
      topics: [plain[0], "Countries", plain[1]],
      sources: ["BBC"],
      subtopics: [
        { topic: "Countries", subtopic: "Uganda" },
        { topic: "Countries", subtopic: "Kenya" },
      ],
    });
    const rows = () => ({
      topics: db.tables.user_topics.map((r) => r.topic).sort(),
      sources: db.tables.user_preferred_sources.map((r) => r.source).sort(),
      subtopics: db.tables.user_subtopics.map((r) => `${r.topic}|${r.subtopic}`).sort(),
    });
    const before = rows();
    const loaded = await getUserProfile(db.client, db.uid);
    // The form has no Countries chip: it sends the other topics and the countries.
    const parsed = ProfileInput.parse({
      topics: loaded.topics.filter((t) => t !== "Countries"),
      preferredSources: loaded.preferredSources,
      countries: loaded.countries,
    });
    await saveUserProfile(db.client, db.uid, parsed.topics, parsed.preferredSources, parsed.countries);
    expect(rows()).toEqual(before);
  });

  it("only this user's rows are deleted", async () => {
    const db = fakeDb({ subtopics: [{ user_id: "other", topic: "Countries", subtopic: "Kenya" }] });
    await saveViaForm(db, { topics: plain.slice(0, 3) });
    expect(db.tables.user_subtopics).toEqual([{ user_id: "other", topic: "Countries", subtopic: "Kenya" }]);
  });

  it("a reader with no Countries sends exactly the old operations plus one Countries-scoped delete", async () => {
    const db = fakeDb();
    await saveViaForm(db, { topics: plain.slice(0, 3) });
    expect(db.ops.sort()).toEqual(
      ["delete user_preferred_sources", "delete user_subtopics", "delete user_topics", "insert user_topics 3"].sort()
    );
  });

  it("a load with Countries saved but every saved country since withdrawn returns countries: []", async () => {
    const db = fakeDb({ topics: ["Countries", plain[0]], subtopics: [{ topic: "Countries", subtopic: "Atlantis" }] });
    const loaded = await getUserProfile(db.client, db.uid);
    expect(loaded.countries).toEqual([]);
    expect(loaded.topics).toContain("Countries");
  });

  it("a load ignores Countries-looking rows stored under another topic", async () => {
    const db = fakeDb({ topics: ["Countries", plain[0]], subtopics: [{ topic: "Football", subtopic: "Kenya" }, { topic: "Countries", subtopic: "Ghana" }] });
    expect((await getUserProfile(db.client, db.uid)).countries).toEqual(["Ghana"]);
  });
});
