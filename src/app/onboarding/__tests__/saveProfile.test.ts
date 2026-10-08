import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCES, TOPICS } from "@/types";

// Both preference actions parse the same FormData shape with ProfileInput
// and hand the result to saveUserProfile. These check the action-level
// outcomes of the 3-to-10 topic rule and optional sources: where a save
// redirects, which code a refusal returns, and what reaches the save.

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  getUser: vi.fn(),
  saveUserProfile: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
// COUNTRIES is empty until the country catalog lands.
vi.mock("@/config/countries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/countries")>()),
  COUNTRIES: ["Uganda", "Kenya", "Morocco"],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/profile")>()),
  saveUserProfile: mocks.saveUserProfile,
}));

const { saveProfile } = await import("@/app/onboarding/actions");
const { updatePreferences } = await import("@/app/(paper)/profile/actions");

function form(topics: readonly string[], sources: readonly string[], countries: readonly string[] = []) {
  const formData = new FormData();
  for (const topic of topics) formData.append("topics", topic);
  for (const source of sources) formData.append("preferredSources", source);
  for (const country of countries) formData.append("countries", country);
  return formData;
}

const nonCountry = TOPICS.filter((t) => t !== "Countries");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.saveUserProfile.mockResolvedValue({ error: null });
});

const actions = [
  { name: "onboarding saveProfile", run: (f: FormData) => saveProfile(null, f), ok: "/" },
  {
    name: "profile updatePreferences",
    run: (f: FormData) => updatePreferences(null, f),
    ok: "/profile?prefsSaved=1",
  },
];

describe.each(actions)("$name", ({ run: action, ok }) => {
  it("saves 3 topics with zero sources", async () => {
    await expect(action(form(TOPICS.slice(0, 3), []))).rejects.toThrow(`REDIRECT:${ok}`);
    expect(mocks.saveUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      TOPICS.slice(0, 3),
      [],
      []
    );
  });

  it("saves 10 topics with sources", async () => {
    await expect(action(form(TOPICS.slice(0, 10), SOURCES.slice(0, 2)))).rejects.toThrow(
      `REDIRECT:${ok}`
    );
    expect(mocks.saveUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      TOPICS.slice(0, 10),
      SOURCES.slice(0, 2),
      []
    );
  });

  it("refuses 2 topics with too_few, saving nothing", async () => {
    await expect(action(form(TOPICS.slice(0, 2), []))).resolves.toEqual({ error: "too_few" });
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("refuses 11 topics with too_many, saving nothing", async () => {
    await expect(action(form(TOPICS.slice(0, 11), []))).resolves.toEqual({ error: "too_many" });
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("reads every repeated countries field and saves the picks", async () => {
    const picked = [...nonCountry.slice(0, 2), "Countries"];
    await expect(action(form(picked, [], ["Morocco", "Uganda"]))).rejects.toThrow(`REDIRECT:${ok}`);
    expect(mocks.saveUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      picked,
      [],
      ["Morocco", "Uganda"]
    );
  });

  it("saves Countries sent with no country as no Countries", async () => {
    await expect(action(form([...nonCountry.slice(0, 3), "Countries"], []))).rejects.toThrow(`REDIRECT:${ok}`);
    expect(mocks.saveUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      nonCountry.slice(0, 3),
      [],
      []
    );
  });

  it("refuses 8 topics plus 3 countries with too_many, saving nothing", async () => {
    await expect(
      action(form([...nonCountry.slice(0, 8), "Countries"], [], ["Uganda", "Kenya", "Morocco"]))
    ).resolves.toEqual({ error: "too_many" });
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("saves the Countries topic with countries sent without it, as the form sends them", async () => {
    await expect(action(form(nonCountry.slice(0, 2), [], ["Kenya"]))).rejects.toThrow(`REDIRECT:${ok}`);
    expect(mocks.saveUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      [...nonCountry.slice(0, 2), "Countries"],
      [],
      ["Kenya"]
    );
  });

  it("refuses an unknown country with unknown_country, without echoing it, saving nothing", async () => {
    const result = await action(form(nonCountry.slice(0, 3), [], ["Atlantis"]));
    expect(result).toEqual({ error: "unknown_country" });
    expect(JSON.stringify(result)).not.toContain("Atlantis");
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("refuses an unknown topic with unknown_topic, saving nothing", async () => {
    await expect(action(form([...nonCountry.slice(0, 3), "<b>Crafted</b>"], []))).resolves.toEqual({
      error: "unknown_topic",
    });
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("refuses an unknown source with unknown_source, saving nothing", async () => {
    await expect(action(form(nonCountry.slice(0, 3), ["Not A Source"]))).resolves.toEqual({
      error: "unknown_source",
    });
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("returns save_failed, not the save's text, when the save fails", async () => {
    mocks.saveUserProfile.mockResolvedValue({ error: "database said something" });
    await expect(action(form(nonCountry.slice(0, 3), []))).resolves.toEqual({ error: "save_failed" });
  });

  it("checks the session first: no user redirects to /login before anything is parsed or saved", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await expect(action(form(TOPICS.slice(0, 2), []))).rejects.toThrow("REDIRECT:/login");
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });
});
