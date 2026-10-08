// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS } from "@/types";

// /profile's preference form as the page builds it: a refused save keeps the
// reader's picks and shows a fixed message, and nothing in the URL is ever
// shown as an error.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  updatePreferences: vi.fn(),
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
vi.mock("@/app/(paper)/profile/actions", () => ({
  updatePreferences: mocks.updatePreferences,
  changePassword: vi.fn(),
}));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PROFILE_ERROR_MESSAGES } = await import("@/lib/profileErrors");
const { default: ProfilePage } = await import("@/app/(paper)/profile/page");

let container: HTMLDivElement;
let root: Root;

const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({
    topics: [...plain.slice(0, 2), COUNTRIES_TOPIC],
    preferredSources: [SOURCES[0]],
    countries: ["Morocco"],
    timeZone: "UTC",
  });
  mocks.updatePreferences.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function renderProfile(searchParams: Record<string, string> = {}) {
  const tree = (await ProfilePage({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
  await act(async () => root.render(tree));
}

const prefsForm = () =>
  [...container.querySelectorAll("form")].find((f) => f.querySelector('input[name="topics"]'))!;

const fieldValues = (name: string) =>
  [...prefsForm().querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

async function submitPrefs() {
  await act(async () => prefsForm().requestSubmit());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("/profile preferences", () => {
  it("keeps the reader's picks after a refused save and shows the code's message", async () => {
    mocks.updatePreferences.mockResolvedValue({ error: "save_failed" });
    await renderProfile();
    const before = {
      topics: fieldValues("topics"),
      countries: fieldValues("countries"),
      preferredSources: fieldValues("preferredSources"),
    };

    await submitPrefs();

    expect(mocks.updatePreferences).toHaveBeenCalledTimes(1);
    expect({
      topics: fieldValues("topics"),
      countries: fieldValues("countries"),
      preferredSources: fieldValues("preferredSources"),
    }).toEqual(before);
    expect(before.countries).toEqual(["Morocco"]);
    expect(prefsForm().querySelector('[role="alert"]')!.textContent).toBe(PROFILE_ERROR_MESSAGES.save_failed);
  });

  it("shows nothing for an old or crafted prefsError link", async () => {
    await renderProfile({ prefsError: "Your account is locked. Call 555-0100" });
    expect(container.textContent).not.toContain("Call 555-0100");
    expect(prefsForm().querySelector('[role="alert"]')).toBeNull();
  });

  it("shows the saved message in the palette's ink, not a hard-coded colour", async () => {
    await renderProfile({ prefsSaved: "1" });
    const saved = [...container.querySelectorAll("p")].find((p) => p.textContent === "Preferences saved.")!;
    expect(saved.getAttribute("style")).toContain("var(--color-foreground)");
  });

  it("drops the saved message once a later save is refused", async () => {
    mocks.updatePreferences.mockResolvedValue({ error: "too_few" });
    await renderProfile({ prefsSaved: "1" });
    await submitPrefs();
    expect(container.textContent).not.toContain("Preferences saved.");
    expect(prefsForm().querySelector('[role="alert"]')!.textContent).toBe(PROFILE_ERROR_MESSAGES.too_few);
  });
});
