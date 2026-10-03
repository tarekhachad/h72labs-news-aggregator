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
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/profile")>()),
  saveUserProfile: mocks.saveUserProfile,
}));

const { saveProfile } = await import("@/app/onboarding/actions");
const { updatePreferences } = await import("@/app/(paper)/profile/actions");

function form(topics: readonly string[], sources: readonly string[]) {
  const formData = new FormData();
  for (const topic of topics) formData.append("topics", topic);
  for (const source of sources) formData.append("preferredSources", source);
  return formData;
}

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
      SOURCES.slice(0, 2)
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
});
