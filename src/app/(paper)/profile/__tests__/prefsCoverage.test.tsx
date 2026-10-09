// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS } from "@/types";

// /profile builds the outlets' coverage on the server and hands the form only
// names: the outlets picker sorts by it, and no feed URL is in what the page
// passes to the browser.

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

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PreferencesForm } = await import("@/components/PreferencesForm");
const { default: ProfilePage } = await import("@/app/(paper)/profile/page");

let container: HTMLDivElement;
let root: Root;

const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC).slice(0, 3);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getUserProfile.mockResolvedValue({ topics: plain, preferredSources: [], countries: [], timeZone: "UTC" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("/profile and the outlets' coverage", () => {
  it("passes the form names only, built from the real catalog, never a feed URL", async () => {
    const tree = (await ProfilePage({ searchParams: Promise.resolve({}) })) as ReactElement;
    const form = findElement(tree, PreferencesForm) as ReactElement<{
      sourceCoverage: Record<string, { topics: string[]; countries: string[] }>;
      action: unknown;
    }> | null;
    expect(form).not.toBeNull();
    // Every prop the browser receives; the action is a server reference, not data.
    expect(JSON.stringify({ ...form!.props, action: null })).not.toMatch(/https?:|\/\//i);
    expect(form!.props.sourceCoverage.BBC.topics).toContain("Tech/AI");
  });

  it("opens the outlets picker on the outlets covering the saved topics", async () => {
    const tree = (await ProfilePage({ searchParams: Promise.resolve({}) })) as ReactElement;
    await act(async () => root.render(tree));
    const input = document.getElementById("preferences-sources") as HTMLInputElement;
    await act(async () => input.focus());
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    await flush();
    const firstGroup = document.querySelector<HTMLElement>('[role="listbox"] [role="group"]')!;
    expect(document.getElementById(firstGroup.getAttribute("aria-labelledby")!)!.textContent).toBe(
      "Covers your topics"
    );
  });
});
