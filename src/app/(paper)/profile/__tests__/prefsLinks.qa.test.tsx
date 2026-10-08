// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS } from "@/types";

// Old or crafted query strings on /profile and /onboarding put no text on
// the page: neither page reads ?error= or ?prefsError= any more.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/profile")>()),
  getUserProfile: mocks.getUserProfile,
}));
vi.mock("@/app/(paper)/profile/actions", () => ({ updatePreferences: vi.fn(), changePassword: vi.fn() }));
vi.mock("@/app/onboarding/actions", () => ({ saveProfile: vi.fn() }));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PROFILE_ERROR_MESSAGES } = await import("@/lib/profileErrors");
const { default: ProfilePage } = await import("@/app/(paper)/profile/page");
const { default: OnboardingPage } = await import("@/app/onboarding/page");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: TOPICS.filter((t) => t !== COUNTRIES_TOPIC).slice(0, 3),
    preferredSources: [SOURCES[0]],
    countries: [],
    timeZone: "UTC",
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const CRAFTED = "Account locked <b>call 555-0100</b>";
const allMessages = Object.values({ ...PROFILE_ERROR_MESSAGES });

function expectNoErrorText() {
  expect(container.textContent).not.toContain("555-0100");
  expect(container.innerHTML).not.toContain("<b>call");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  for (const m of allMessages) expect(container.textContent).not.toContain(m);
}

describe("crafted links", () => {
  it.each([
    [{ prefsError: CRAFTED }],
    [{ error: CRAFTED }],
    [{ prefsError: "too_few" }],
    [{ error: "save_failed" }],
    [{ prefsError: CRAFTED, error: CRAFTED, prefsSaved: "" }],
  ])("/profile with %j shows no message", async (params) => {
    const tree = (await ProfilePage({ searchParams: Promise.resolve(params as never) })) as ReactElement;
    await act(async () => root.render(tree));
    expectNoErrorText();
  });

  it("/profile?prefsSaved=<crafted> shows only the fixed saved text", async () => {
    const tree = (await ProfilePage({ searchParams: Promise.resolve({ prefsSaved: CRAFTED }) })) as ReactElement;
    await act(async () => root.render(tree));
    expect(container.textContent).toContain("Preferences saved.");
    expectNoErrorText();
  });

  it.each([[{ error: CRAFTED }], [{ error: "too_few" }], [{ prefsError: "save_failed" }]])(
    "/onboarding rendered with searchParams %j shows no message",
    async (params) => {
      // Only a reader with no topics sees onboarding; one with topics is sent to /profile.
      mocks.getUserProfile.mockResolvedValue({ topics: [], preferredSources: [], countries: [], timeZone: "UTC" });
      const Page = OnboardingPage as unknown as (p: unknown) => Promise<ReactElement>;
      const tree = await Page({ searchParams: Promise.resolve(params) });
      await act(async () => root.render(tree));
      expectNoErrorText();
      expect(container.querySelector("form")).not.toBeNull();
    }
  );
});
