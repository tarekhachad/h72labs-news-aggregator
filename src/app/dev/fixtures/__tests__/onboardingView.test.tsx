import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// /dev/fixtures?view=onboarding: the stepped onboarding form with a save
// that reaches nothing, for screenshots with dead keys. The other views keep
// working beside it.

vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

function underFixtures() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:9");
}

type Saver = (previous: unknown, formData: FormData) => Promise<unknown>;

describe("the onboarding fixture view", () => {
  it("renders the onboarding view on its own, outside the newspaper shell, with a save that does nothing", async () => {
    underFixtures();
    const { default: DevFixturesPage } = await import("@/app/dev/fixtures/page");
    const { OnboardingView } = await import("@/components/onboarding/OnboardingView");
    const tree = (await DevFixturesPage({ searchParams: Promise.resolve({ view: "onboarding" }) })) as ReactElement<{
      action: Saver;
    }>;
    expect(tree.type).toBe(OnboardingView);
    expect(await tree.props.action(undefined, new FormData())).toBeUndefined();
  });

  it("with refuse=1, comes back refused as a failed save would", async () => {
    underFixtures();
    const { default: DevFixturesPage } = await import("@/app/dev/fixtures/page");
    const tree = (await DevFixturesPage({
      searchParams: Promise.resolve({ view: "onboarding", refuse: "1" }),
    })) as ReactElement<{ action: Saver }>;
    expect(await tree.props.action(undefined, new FormData())).toEqual({ error: "save_failed" });
  });

  it("is a 404 with the real keys loaded", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SUPABASE_URL", "https://abcdefghijklmnop.supabase.co");
    const { default: DevFixturesPage } = await import("@/app/dev/fixtures/page");
    await expect(DevFixturesPage({ searchParams: Promise.resolve({ view: "onboarding" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("keeps ?view=prefs as the single-page form", async () => {
    underFixtures();
    const { default: DevFixturesPage } = await import("@/app/dev/fixtures/page");
    const { PreferencesForm } = await import("@/components/PreferencesForm");
    const tree = (await DevFixturesPage({ searchParams: Promise.resolve({ view: "prefs" }) })) as ReactElement;
    const json = JSON.stringify(tree, (_key, value) => (typeof value === "function" ? value.name : value));
    expect(json).toContain(PreferencesForm.name);
    expect(json).not.toContain('"stepped":true');
  });
});
