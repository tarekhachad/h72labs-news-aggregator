import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCES, TOPICS } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { PROFILE_ERROR_MESSAGES, profileErrorCode } from "@/lib/profileErrors";

// Both preference actions, against the real country catalog, with crafted and hostile FormData. A refusal must be
// exactly { error: <known code> } and carry nothing the reader submitted.

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  getUser: vi.fn(),
  saveUserProfile: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/profile")>()),
  saveUserProfile: mocks.saveUserProfile,
}));

const { saveProfile } = await import("@/app/onboarding/actions");
const { updatePreferences } = await import("@/app/(paper)/profile/actions");

const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);
const CODES = Object.keys(PROFILE_ERROR_MESSAGES);

type Entry = [field: "topics" | "preferredSources" | "countries", value: string | Blob];
function form(entries: Entry[]) {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}
const topics = (list: readonly string[]): Entry[] => list.map((t) => ["topics", t]);
const countries = (list: readonly string[]): Entry[] => list.map((c) => ["countries", c]);
const sources = (list: readonly string[]): Entry[] => list.map((s) => ["preferredSources", s]);

const HTML = `<img src=x onerror="alert(1)">`;
const LONG = "A".repeat(200_000);
const evilFile = () => new File(["<script>alert(1)</script>"], "evil<b>.html", { type: "text/html" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.saveUserProfile.mockResolvedValue({ error: null });
});

const actions = [
  { name: "onboarding saveProfile", run: (f: FormData) => saveProfile(undefined, f), ok: "/" },
  { name: "profile updatePreferences", run: (f: FormData) => updatePreferences(undefined, f), ok: "/profile?prefsSaved=1" },
];

describe.each(actions)("QA: $name", ({ run, ok }) => {
  const refusals: [string, Entry[], string, string | null][] = [
    ["HTML as a topic", [...topics(plain.slice(0, 3)), ["topics", HTML]], "unknown_topic", HTML],
    ["HTML as a country", [...topics(plain.slice(0, 3)), ["countries", HTML]], "unknown_country", HTML],
    ["HTML as a source", [...topics(plain.slice(0, 3)), ["preferredSources", HTML]], "unknown_source", HTML],
    ["a 200k-char topic", [...topics(plain.slice(0, 3)), ["topics", LONG]], "unknown_topic", LONG.slice(0, 50)],
    ["a 200k-char country", [...topics(plain.slice(0, 3)), ["countries", LONG]], "unknown_country", LONG.slice(0, 50)],
    ["a File as a topic", [...topics(plain.slice(0, 3)), ["topics", evilFile()]], "unknown_topic", "evil"],
    ["a File as a country", [...topics(plain.slice(0, 3)), ["countries", evilFile()]], "unknown_country", "evil"],
    ["a File as a source", [...topics(plain.slice(0, 3)), ["preferredSources", evilFile()]], "unknown_source", "evil"],
    ["__proto__ as a topic", [...topics(plain.slice(0, 3)), ["topics", "__proto__"]], "unknown_topic", "__proto__"],
    ["toString as a country", [...topics(plain.slice(0, 3)), ["countries", "toString"]], "unknown_country", "toString"],
    ["a country in the wrong case", [...topics(plain.slice(0, 3)), ["countries", "morocco"]], "unknown_country", "morocco"],
    ["a country with padding", [...topics(plain.slice(0, 3)), ["countries", " Morocco"]], "unknown_country", null],
    ["nothing at all", [], "too_few", null],
    ["only Countries as a topic", topics([COUNTRIES_TOPIC]), "too_few", null],
    ["2 topics + Countries, no country", topics([...plain.slice(0, 2), COUNTRIES_TOPIC]), "too_few", null],
    ["the same topic three times", topics([plain[0], plain[0], plain[0]]), "too_few", null],
    ["1 topic + the same country twice", [...topics(plain.slice(0, 1)), ...countries(["Morocco", "Morocco"])], "too_few", null],
    ["11 topics", topics(plain.slice(0, 11)), "too_many", null],
    ["8 topics + 3 countries", [...topics(plain.slice(0, 8)), ...countries(["Morocco", "Kenya", "Ghana"])], "too_many", null],
    // Both wrong: the unknown value is reported before the count.
    ["too few AND an unknown country", [...topics(plain.slice(0, 1)), ["countries", "Atlantis"]], "unknown_country", "Atlantis"],
    ["unknown topic AND unknown country", [["topics", "Atlantis"], ["countries", "Atlantis2"]], "unknown_topic", "Atlantis"],
  ];

  const rows = refusals.map(([name, entries, code, echo]) => ({ name, entries, code, echo }));
  it.each(rows)("refuses $name with exactly { error: $code }, echoing nothing", async ({ entries, code, echo }) => {
    const result = await run(form(entries));
    expect(result).toEqual({ error: code });
    expect(Object.keys(result as object)).toEqual(["error"]);
    expect(CODES).toContain((result as { error: string }).error);
    if (echo) expect(JSON.stringify(result)).not.toContain(echo);
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("saves 2 topics + 1 country (3 units) and redirects", async () => {
    await expect(run(form([...topics(plain.slice(0, 2)), ...countries(["Morocco"])]))).rejects.toThrow(`REDIRECT:${ok}`);
    expect(mocks.saveUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      [...plain.slice(0, 2), COUNTRIES_TOPIC],
      [],
      ["Morocco"]
    );
  });

  it("returns save_failed and never the database text", async () => {
    const secret = `relation "user_topics" violates <b>policy</b> for 555-0100`;
    mocks.saveUserProfile.mockResolvedValue({ error: secret });
    const result = await run(form([...topics(plain.slice(0, 3)), ...sources(SOURCES.slice(0, 1))]));
    expect(result).toEqual({ error: "save_failed" });
    expect(JSON.stringify(result)).not.toContain("555-0100");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("checks the session before parsing hostile input: /login, nothing saved", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await expect(run(form([["topics", HTML], ["countries", evilFile()]]))).rejects.toThrow("REDIRECT:/login");
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("ignores the previous state entirely (a crafted previous state changes nothing)", async () => {
    const f = form(topics(plain.slice(0, 2)));
    const action = run === actions[0].run ? saveProfile : updatePreferences;
    await expect(action({ error: "<script>" } as never, f)).resolves.toEqual({ error: "too_few" });
  });
});

describe("QA: profileErrorCode against prototype keys and odd issues", () => {
  it.each(["toString", "__proto__", "constructor", "hasOwnProperty", 42, null, { code: "too_few" }])(
    "a custom issue with params.code %s maps to invalid",
    (code) => {
      expect(profileErrorCode([{ code: "custom", path: [], params: { code } as Record<string, unknown> }])).toBe("invalid");
    }
  );

  it("a custom issue on the topics field without a code is invalid, not unknown_topic", () => {
    expect(profileErrorCode([{ code: "custom", path: ["topics"] }])).toBe("invalid");
  });

  it("maps a built-in issue by its first path segment only", () => {
    expect(profileErrorCode([{ code: "invalid_value", path: ["countries", 3] }])).toBe("unknown_country");
    expect(profileErrorCode([{ code: "invalid_type", path: [] }])).toBe("invalid");
    expect(profileErrorCode([{ code: "invalid_type", path: [Symbol("topics")] }])).toBe("invalid");
  });

  it("reads only the first issue", () => {
    expect(
      profileErrorCode([
        { code: "invalid_value", path: ["preferredSources", 0] },
        { code: "invalid_value", path: ["topics", 0] },
      ])
    ).toBe("unknown_source");
  });
});
