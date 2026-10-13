// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { redirect } from "next/navigation";

// The sign-out confirmation, through both of its callers (the newspaper
// menu and onboarding's header), since they now share one hook: the same
// words, nothing signed out until confirmed, every dismiss path ignored
// while signing out, a redirect passed through rather than shown as a
// failure, and a real failure shown in the dialog.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const signOutAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/auth/actions", () => ({ signOutAction }));

const { Sidebar } = await import("@/components/newspaper/Sidebar");
const { SignOutButton } = await import("@/components/onboarding/SignOutButton");

const FAILURE = "Couldn't sign you out — check your connection and try again.";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  signOutAction.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const dialog = () => document.querySelector('[role="dialog"][aria-modal="true"]');
const button = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);

const callers = [
  {
    name: "the newspaper menu",
    render: () => root.render(<Sidebar />),
    async open() {
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!.click());
      await act(async () => button(document, "Sign out")!.click());
    },
  },
  {
    name: "onboarding's header",
    render: () => root.render(<SignOutButton />),
    async open() {
      await act(async () => button(container, "Sign out")!.click());
    },
  },
];

describe.each(callers)("signing out from $name", (caller) => {
  beforeEach(async () => {
    await act(async () => caller.render());
    await caller.open();
  });

  it("asks first, with the shared wording", () => {
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(d.querySelector("h2")!.textContent).toBe("Sign out?");
    expect(d.textContent).toContain("You'll need to sign in again to read your digest.");
    expect(button(d, "Sign out")).toBeDefined();
    expect(signOutAction).not.toHaveBeenCalled();
  });

  it("portals the dialog to document.body, outside the caller's tree", () => {
    expect(container.contains(dialog())).toBe(false);
  });

  it("closes on Cancel without signing out", async () => {
    await act(async () => button(dialog()!, "Cancel")!.click());
    expect(dialog()).toBeNull();
    expect(signOutAction).not.toHaveBeenCalled();
  });

  it("ignores Cancel, Escape and the backdrop while signing out", async () => {
    // Settled before the test ends: React ties every transition started
    // while an async one is still pending to it, so a promise left hanging
    // here would hold the next test's sign-out pending too.
    let settle!: () => void;
    signOutAction.mockReturnValue(new Promise<void>((r) => (settle = r)));
    await act(async () => button(dialog()!, "Sign out")!.click());
    expect(signOutAction).toHaveBeenCalledTimes(1);
    const d = dialog()!;
    expect(button(d, "Cancel")!.disabled).toBe(true);
    expect(button(d, "Sign out")!.disabled).toBe(true);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => document.querySelector<HTMLElement>(".fixed.inset-0.z-40")!.click());
    expect(dialog()).not.toBeNull();
    await act(async () => settle());
  });

  it("passes a redirect through instead of showing it as a failure", async () => {
    signOutAction.mockImplementation(async () => redirect("/login"));
    // The redirect re-raised out of the transition, which act surfaces as
    // its own rejection; swallowed, it would have shown the failure text.
    await expect(act(async () => button(dialog()!, "Sign out")!.click())).rejects.toThrow("NEXT_REDIRECT");
    expect(document.body.textContent).not.toContain(FAILURE);
  });

  it("shows a real failure in the dialog, and lets the reader back out", async () => {
    signOutAction.mockRejectedValue(new Error("offline"));
    await act(async () => button(dialog()!, "Sign out")!.click());
    const alert = dialog()!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe(FAILURE);
    expect(button(dialog()!, "Cancel")!.disabled).toBe(false);

    await act(async () => button(dialog()!, "Cancel")!.click());
    expect(dialog()).toBeNull();
  });
});

it("closes the menu sheet before the confirmation opens", async () => {
  await act(async () => root.render(<Sidebar />));
  await callers[0].open();
  expect(dialog()).not.toBeNull();
  expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
});
