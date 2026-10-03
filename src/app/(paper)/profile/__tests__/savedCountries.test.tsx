// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS } from "@/types";

// /profile hands the reader's saved countries to the countries picker.

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
vi.mock("@/app/(paper)/profile/actions", () => ({
  updatePreferences: vi.fn(),
  changePassword: vi.fn(),
}));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));
vi.mock("@/config/countries", async (importActual) => ({
  ...(await importActual<typeof import("@/config/countries")>()),
  COUNTRIES: ["Kenya", "Morocco", "Uganda"],
}));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { default: ProfilePage } = await import("@/app/(paper)/profile/page");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

describe("/profile with saved countries", () => {
  it("loads them into the countries picker and counts each one", async () => {
    const topics = [...TOPICS.filter((t) => t !== COUNTRIES_TOPIC).slice(0, 3), COUNTRIES_TOPIC];
    mocks.getUserProfile.mockResolvedValue({
      topics,
      preferredSources: [],
      countries: ["Uganda", "Kenya"],
      timeZone: "UTC",
    });
    const tree = (await ProfilePage({ searchParams: Promise.resolve({}) })) as ReactElement;
    await act(async () => root.render(tree));

    expect(fieldValues("topics")).toEqual(topics);
    expect(fieldValues("countries")).toEqual(["Uganda", "Kenya"]);
    expect(document.getElementById("preferences-topics-count")!.textContent).toBe("5 of 10");
  });
});
