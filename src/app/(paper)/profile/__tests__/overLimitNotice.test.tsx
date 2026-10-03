// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS } from "@/types";
import { MAX_TOPICS } from "@/lib/profile";

// A reader saved more topics than the limit allows before it existed. The
// profile page must still load them all and ask, without blocking, for a
// trim before the next save. The page is an async server component: it is
// awaited for its element tree, which is then rendered in jsdom.

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

async function renderProfile(topicCount: number) {
  mocks.getUserProfile.mockResolvedValue({
    topics: TOPICS.slice(0, topicCount),
    preferredSources: [],
    timeZone: "UTC",
  });
  const tree = (await ProfilePage({ searchParams: Promise.resolve({}) })) as ReactElement;
  await act(async () => root.render(tree));
}

const trimNotice = () =>
  [...container.querySelectorAll('p[role="status"]')].find((p) =>
    p.textContent?.includes(`limit is now ${MAX_TOPICS}`)
  );

describe("/profile with more saved topics than the limit", () => {
  it("loads every saved topic and shows the trim notice", async () => {
    await renderProfile(MAX_TOPICS + 3);

    const submitted = [
      ...container.querySelectorAll<HTMLInputElement>('input[name="topics"]'),
    ].map((i) => i.value);
    expect(submitted).toEqual(TOPICS.slice(0, MAX_TOPICS + 3));
    expect(trimNotice()?.textContent).toContain("Remove 3 before you next save");

    // Nothing else is blocked: the save button is live.
    const save = [...container.querySelectorAll("button[type=submit]")].find(
      (b) => b.textContent === "Save preferences"
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("shows no notice at the limit", async () => {
    await renderProfile(MAX_TOPICS);
    expect(trimNotice()).toBeUndefined();
  });

  it("renders a profile with zero preferred sources", async () => {
    await renderProfile(3);
    expect(container.querySelectorAll('input[name="preferredSources"]')).toHaveLength(0);
    expect(document.getElementById("preferences-sources-count")!.textContent).toBe("0 selected");
  });
});
