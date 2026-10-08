// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// /profile's Change password form: a show/hide button on each of its three
// fields, the rule under the new password, and every input attribute the
// changePassword action and password managers rely on left as it was.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const changePassword = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } })),
}));
vi.mock("@/lib/profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/profile")>()),
  getUserProfile: vi.fn(async () => ({ topics: [], preferredSources: [], countries: [], timeZone: "UTC" })),
}));
vi.mock("@/app/(paper)/profile/actions", () => ({ updatePreferences: vi.fn(), changePassword }));
vi.mock("@/components/TimeZoneSync", () => ({ TimeZoneSync: () => null }));
// The preferences half of the page isn't under test here.
vi.mock("@/components/PreferencesForm", () => ({ PreferencesForm: () => null }));

const { default: ProfilePage } = await import("@/app/(paper)/profile/page");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  changePassword.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function renderProfile(searchParams: Record<string, string> = {}) {
  const tree = (await ProfilePage({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
  await act(async () => root.render(tree));
}

const field = (name: string) => container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const toggleFor = (input: HTMLInputElement) =>
  container.querySelector<HTMLButtonElement>(`button[aria-controls="${input.id}"]`)!;

describe("Change password", () => {
  it.each([
    ["currentPassword", "current-password", true],
    ["newPassword", "new-password", false],
    ["confirmPassword", "new-password", false],
  ])("%s keeps autoComplete=%s and required=%s, and has its own toggle", async (name, autoComplete, required) => {
    await renderProfile();
    const input = field(name);
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe(autoComplete);
    expect(input.required).toBe(required);
    expect(input.hasAttribute("minlength")).toBe(false);

    const toggle = toggleFor(input);
    expect(toggle.type).toBe("button");
    await act(async () => toggle.click());
    expect(input.type).toBe("text");
    expect(toggle.getAttribute("aria-label")).toBe("Hide password");
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("toggles each field on its own", async () => {
    await renderProfile();
    await act(async () => toggleFor(field("newPassword")).click());
    expect(field("newPassword").type).toBe("text");
    expect(field("currentPassword").type).toBe("password");
    expect(field("confirmPassword").type).toBe("password");
  });

  it("shows the rule under the new password only", async () => {
    await renderProfile();
    const rules = [...container.querySelectorAll("p")].filter((p) => p.textContent === "At least 6 characters");
    expect(rules).toHaveLength(1);
    expect(field("newPassword").getAttribute("aria-describedby")).toBe(rules[0].id);
    expect(field("currentPassword").hasAttribute("aria-describedby")).toBe(false);
    expect(field("confirmPassword").hasAttribute("aria-describedby")).toBe(false);
  });

  it("all three fields sit in the one form the action receives", async () => {
    await renderProfile();
    const form = field("currentPassword").form!;
    expect(field("newPassword").form).toBe(form);
    expect(field("confirmPassword").form).toBe(form);
    expect(form.querySelectorAll('button[type="submit"]')).toHaveLength(1);
  });

  it("still shows a password error code's fixed message", async () => {
    await renderProfile({ pwError: "password_mismatch" });
    expect(container.textContent).toContain("Passwords don't match.");
  });
});
