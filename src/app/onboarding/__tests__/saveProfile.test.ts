import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCES, TOPICS } from "@/types";

// Both preference actions parse the same FormData shape with ProfileInput
// and hand the result to saveUserProfile. These check the action-level
// outcomes of the 3-to-10 topic rule and optional sources: where each case
// redirects, and what reaches the save.

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
  { name: "onboarding saveProfile", action: saveProfile, ok: "/", errorBase: "/onboarding?error=" },
  {
    name: "profile updatePreferences",
    action: updatePreferences,
    ok: "/profile?prefsSaved=1",
    errorBase: "/profile?prefsError=",
  },
];

describe.each(actions)("$name", ({ action, ok, errorBase }) => {
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

  it("sends 2 topics back with the minimum message, saving nothing", async () => {
    await expect(action(form(TOPICS.slice(0, 2), []))).rejects.toThrow(
      `REDIRECT:${errorBase}${encodeURIComponent("Pick at least 3 topics")}`
    );
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("sends 11 topics back with the maximum message, saving nothing", async () => {
    await expect(action(form(TOPICS.slice(0, 11), []))).rejects.toThrow(
      `REDIRECT:${errorBase}${encodeURIComponent("Pick at most 10 topics")}`
    );
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

  it("sends Countries with no country back with its message, saving nothing", async () => {
    await expect(action(form([...nonCountry.slice(0, 3), "Countries"], []))).rejects.toThrow(
      `REDIRECT:${errorBase}${encodeURIComponent("Pick at least one country, or remove Countries")}`
    );
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("sends 8 topics plus 3 countries back with the maximum message, saving nothing", async () => {
    await expect(
      action(form([...nonCountry.slice(0, 8), "Countries"], [], ["Uganda", "Kenya", "Morocco"]))
    ).rejects.toThrow(
      `REDIRECT:${errorBase}${encodeURIComponent("Pick at most 10 topics and countries (each country counts as one)")}`
    );
    expect(mocks.saveUserProfile).not.toHaveBeenCalled();
  });

  it("drops countries sent without the Countries topic", async () => {
    await expect(action(form(nonCountry.slice(0, 3), [], ["Kenya"]))).rejects.toThrow(`REDIRECT:${ok}`);
    expect(mocks.saveUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      nonCountry.slice(0, 3),
      [],
      []
    );
  });
});
