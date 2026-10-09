// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS } from "@/types";

// /onboarding as the page builds it: only a signed-in reader with no topics
// sees the stepped form (one with topics is sent to /profile, so a stray visit
// can't save a blank form over their profile); the time zone is synced; a
// refused save keeps the picks the reader made and shows a fixed message;
// and the page reads no query string, so an old or crafted ?error= link has
// nothing to show.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  getUser: vi.fn(),
  getUserProfile: vi.fn(),
  timeZoneSync: vi.fn(),
}));
vi.mock("@/app/onboarding/actions", () => ({ saveProfile: mocks.saveProfile }));
vi.mock("next/navigation", async (importActual) => ({
  ...(await importActual<typeof import("next/navigation")>()),
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
vi.mock("@/components/TimeZoneSync", () => ({
  TimeZoneSync: (props: { storedTimeZone: string }) => {
    mocks.timeZoneSync(props.storedTimeZone);
    return null;
  },
}));
vi.mock("@/app/auth/actions", () => ({ signOutAction: vi.fn() }));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PROFILE_ERROR_MESSAGES } = await import("@/lib/profileErrors");
const { default: OnboardingPage } = await import("@/app/onboarding/page");
const { clickChip } = await import("@/components/__tests__/topicGridKit");

let container: HTMLDivElement;
let root: Root;

const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.saveProfile.mockReset();
  mocks.timeZoneSync.mockReset();
  mocks.getUserProfile.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: [], preferredSources: [], countries: [], timeZone: "Africa/Casablanca" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function renderPage(props: unknown = {}) {
  const render = OnboardingPage as unknown as (p: unknown) => Promise<ReactElement>;
  const tree = await render(props);
  await act(async () => root.render(tree));
}

async function key(target: Element, k: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

async function pickCountry(label: string) {
  const input = document.getElementById("preferences-countries") as HTMLInputElement;
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  await flush();
  const option = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  )!;
  await act(async () => option.click());
  await flush();
  await key(input, "Escape");
}

const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name)!;

async function press(name: string) {
  await act(async () => button(name).click());
  await flush();
}

const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

describe("/onboarding", () => {
  it("sends a reader who already has topics to /profile", async () => {
    mocks.getUserProfile.mockResolvedValue({
      topics: plain.slice(0, 3),
      preferredSources: [],
      countries: [],
      timeZone: "UTC",
    });
    await expect(renderPage()).rejects.toThrow("REDIRECT:/profile");
  });

  it("sends a signed-out visit to /login", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await expect(renderPage()).rejects.toThrow("REDIRECT:/login");
    expect(mocks.getUserProfile).not.toHaveBeenCalled();
  });

  it("shows a reader with no topics the stepped form, and syncs their time zone", async () => {
    await renderPage();
    expect(container.querySelector("form")).not.toBeNull();
    expect(container.textContent).toContain("Step 1 of 4");
    expect(container.querySelector("h2")!.textContent).toBe("Pick your topics");
    expect(mocks.timeZoneSync).toHaveBeenCalledWith("Africa/Casablanca");
  });

  it("keeps the picks made on the page after a refused save, with the code's message on Review", async () => {
    mocks.saveProfile.mockResolvedValue({ error: "too_few" });
    await renderPage();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    for (const topic of plain.slice(0, 3)) await clickChip(topic);
    await press("Next: Countries");
    await pickCountry("Morocco");
    await press("Next: Outlets");
    await press("Skip");
    expect(container.textContent).toContain("Step 4 of 4");

    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();

    expect(mocks.saveProfile).toHaveBeenCalledTimes(1);
    const sent = mocks.saveProfile.mock.calls[0][1] as FormData;
    expect(sent.getAll("topics")).toEqual(plain.slice(0, 3));
    expect(sent.getAll("countries")).toEqual(["Morocco"]);
    expect(fieldValues("topics")).toEqual(plain.slice(0, 3));
    expect(fieldValues("countries")).toEqual(["Morocco"]);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe(PROFILE_ERROR_MESSAGES.too_few);
    // On the Review step, which is still the one showing.
    expect(alert.closest("section")!.hidden).toBe(false);
    expect(container.textContent).toContain("Step 4 of 4");
  });

  it("hands the form the outlets' coverage from the real catalog, with no feed URL in it", async () => {
    const { SourceCoverageProvider } = await import("@/components/PreferencesForm");
    const render = OnboardingPage as unknown as (p: unknown) => Promise<ReactElement<{ children: ReactElement[] }>>;
    const tree = await render({});
    const provider = tree.props.children.find((child) => child.type === SourceCoverageProvider) as
      | ReactElement<{ coverage: Record<string, { topics: string[]; countries: string[] }> }>
      | undefined;
    expect(provider).toBeDefined();
    const json = JSON.stringify(provider!.props);
    expect(json).not.toMatch(/https?:|\/\//i);
    expect(provider!.props.coverage.BBC.topics).toContain("Tech/AI");
  });

  it("sorts the outlets step by what each outlet covers for the topics picked", async () => {
    await renderPage();
    for (const topic of plain.slice(0, 3)) await clickChip(topic);
    await press("Next: Countries");
    await press("Skip");
    const input = document.getElementById("preferences-sources") as HTMLInputElement;
    await act(async () => input.focus());
    await key(input, "ArrowDown");
    await flush();
    const firstGroup = document.querySelector<HTMLElement>('[role="listbox"] [role="group"]')!;
    expect(document.getElementById(firstGroup.getAttribute("aria-labelledby")!)!.textContent).toBe(
      "Covers your topics"
    );
    expect(firstGroup.querySelector('[role="option"]')!.textContent).toMatch(/ · \d+ of your topics$/);
  });

  it("shows nothing from an old or crafted ?error= link", async () => {
    await renderPage({ searchParams: Promise.resolve({ error: "Your account is locked. Call 555-0100" }) });
    expect(container.textContent).not.toContain("555-0100");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
