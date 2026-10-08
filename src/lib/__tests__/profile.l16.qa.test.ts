import { describe, it, expect, vi } from "vitest";
import { TOPICS, type Topic } from "@/types";

// QA (V2.7 L16): the server derives the Countries topic from the countries.

vi.mock("@/config/countries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/countries")>()),
  COUNTRIES: ["Uganda", "Kenya", "Morocco", "Ghana"],
}));

import { ProfileInput } from "@/lib/profile";

const plain = TOPICS.filter((t) => t !== "Countries") as Topic[];
const parse = (topics: unknown[], countries?: unknown[]) =>
  ProfileInput.safeParse(
    countries === undefined ? { topics, preferredSources: [] } : { topics, preferredSources: [], countries }
  );
const msg = (r: ReturnType<typeof parse>) => (r.success ? null : r.error.issues[0]?.message);

describe("ProfileInput derives Countries from the countries", () => {
  it("Countries sent among topics with no country is dropped, and the save is otherwise unchanged", () => {
    const r = parse(["Countries", ...plain.slice(0, 3)], []);
    expect(r.success).toBe(true);
    expect(r.data!.topics).toEqual(plain.slice(0, 3));
    expect(r.data!.countries).toEqual([]);
  });

  it("Countries sent among topics with no country never yields the old 'pick a country' error", () => {
    expect(msg(parse(["Countries", plain[0], plain[1]], []))).toBe("Pick at least 3 topics");
  });

  it("a country without Countries among topics adds the topic, exactly once, at the end", () => {
    const r = parse([plain[0], plain[1]], ["Kenya"]);
    expect(r.success).toBe(true);
    expect(r.data!.topics).toEqual([plain[0], plain[1], "Countries"]);
  });

  it("Countries sent in the middle of topics, with countries, ends up exactly once", () => {
    const r = parse([plain[0], "Countries", plain[1], "Countries"], ["Kenya"]);
    expect(r.data!.topics).toEqual([plain[0], plain[1], "Countries"]);
  });

  it("an unknown country is refused whether or not Countries is among the topics", () => {
    expect(msg(parse(plain.slice(0, 3), ["Atlantis"]))).toBe("Atlantis isn't a country you can pick");
    expect(msg(parse(["Countries", ...plain.slice(0, 3)], ["Atlantis"]))).toBe(
      "Atlantis isn't a country you can pick"
    );
    expect(msg(parse(plain.slice(0, 3), ["Kenya", "Atlantis"]))).toBe("Atlantis isn't a country you can pick");
  });

  it("units: 2 topics + 1 country passes; 2 + 0 fails; 9 + 1 passes; 9 + 2 fails", () => {
    expect(parse(plain.slice(0, 2), ["Kenya"]).success).toBe(true);
    expect(msg(parse(plain.slice(0, 2), []))).toBe("Pick at least 3 topics");
    expect(parse(plain.slice(0, 9), ["Kenya"]).success).toBe(true);
    expect(msg(parse(plain.slice(0, 9), ["Kenya", "Ghana"]))).toBe(
      "Pick at most 10 topics and countries (each country counts as one)"
    );
  });

  it("countries only: 3 countries is a valid profile of just the Countries topic", () => {
    const r = parse([], ["Kenya", "Ghana", "Uganda"]);
    expect(r.data).toEqual({ topics: ["Countries"], preferredSources: [], countries: ["Kenya", "Ghana", "Uganda"] });
  });

  it("a form without a countries field still parses as before", () => {
    const r = parse(plain.slice(0, 3));
    expect(r.data).toEqual({ topics: plain.slice(0, 3), preferredSources: [], countries: [] });
  });
});
