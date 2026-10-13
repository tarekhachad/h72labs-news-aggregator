// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notFound, redirect } from "next/navigation";

// QA round 1: the shared sign-out hook, in the paths the lane's own test
// leaves out: the error is cleared on reopen and on retry, a second click
// while pending signs out once, Escape and the backdrop close it when idle,
// two callers mounted together keep separate state, the caller's tree goes
// inert while the dialog does not, and other Next control-flow errors pass
// through like a redirect.

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

const dialogs = () => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
const dialog = () => dialogs()[0] ?? null;
const button = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const alertText = () => dialog()?.querySelector('[role="alert"]')?.textContent ?? null;

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

describe.each(callers)("QA: signing out from $name", (caller) => {
  beforeEach(async () => {
    await act(async () => caller.render());
    await caller.open();
  });

  it("clears a shown failure when the dialog is closed and reopened", async () => {
    signOutAction.mockRejectedValue(new Error("offline"));
    await act(async () => button(dialog()!, "Sign out")!.click());
    expect(alertText()).toBe(FAILURE);
    await act(async () => button(dialog()!, "Cancel")!.click());
    expect(dialog()).toBeNull();
    await caller.open();
    expect(dialog()).not.toBeNull();
    expect(alertText()).toBeNull();
  });

  it("clears the failure while a retry is in flight, then a retry that redirects is not shown as a failure", async () => {
    signOutAction.mockRejectedValueOnce(new Error("offline"));
    await act(async () => button(dialog()!, "Sign out")!.click());
    expect(alertText()).toBe(FAILURE);

    let settle!: () => void;
    signOutAction.mockReturnValueOnce(new Promise<void>((r) => (settle = r)));
    await act(async () => button(dialog()!, "Sign out")!.click());
    expect(alertText()).toBeNull();
    expect(button(dialog()!, "Sign out")!.disabled).toBe(true);
    await act(async () => settle());

    signOutAction.mockImplementationOnce(async () => redirect("/login"));
    await expect(act(async () => button(dialog()!, "Sign out")!.click())).rejects.toThrow("NEXT_REDIRECT");
    expect(document.body.textContent).not.toContain(FAILURE);
    expect(signOutAction).toHaveBeenCalledTimes(3);
  });

  it("a second click on Sign out while pending does not sign out twice", async () => {
    let settle!: () => void;
    signOutAction.mockReturnValue(new Promise<void>((r) => (settle = r)));
    const confirm = button(dialog()!, "Sign out")!;
    await act(async () => confirm.click());
    await act(async () => confirm.click());
    await act(async () => button(dialog()!, "Sign out")!.click());
    expect(signOutAction).toHaveBeenCalledTimes(1);
    await act(async () => settle());
  });

  it("Escape closes it when nothing is in flight", async () => {
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(dialog()).toBeNull();
    expect(signOutAction).not.toHaveBeenCalled();
  });

  it("the backdrop closes it when nothing is in flight", async () => {
    await act(async () => document.querySelector<HTMLElement>(".fixed.inset-0.z-40")!.click());
    expect(dialog()).toBeNull();
    expect(signOutAction).not.toHaveBeenCalled();
  });

  it("makes the caller's tree inert but not the dialog", () => {
    expect(container.inert).toBe(true);
    const d = dialog()!;
    let el: HTMLElement | null = d as HTMLElement;
    while (el) {
      expect(el.inert).toBeFalsy(); // jsdom has no native inert, so unset reads undefined
      el = el.parentElement;
    }
  });

  it("passes notFound through like a redirect, not as a failure", async () => {
    signOutAction.mockImplementation(async () => notFound());
    await expect(act(async () => button(dialog()!, "Sign out")!.click())).rejects.toThrow();
    expect(document.body.textContent).not.toContain(FAILURE);
  });

  it("shows the failure for a non-Error rejection too", async () => {
    signOutAction.mockRejectedValue("network down");
    await act(async () => button(dialog()!, "Sign out")!.click());
    expect(alertText()).toBe(FAILURE);
  });
});

it("QA: the two callers mounted together keep separate state", async () => {
  await act(async () =>
    root.render(
      <>
        <Sidebar />
        <SignOutButton />
      </>
    )
  );
  await act(async () => button(container, "Sign out")!.click());
  expect(dialogs()).toHaveLength(1);
  signOutAction.mockRejectedValue(new Error("offline"));
  await act(async () => button(dialog()!, "Sign out")!.click());
  expect(alertText()).toBe(FAILURE);
  await act(async () => button(dialog()!, "Cancel")!.click());
  expect(dialogs()).toHaveLength(0);

  // The menu's own dialog opens clean: the onboarding instance's error never leaked into it.
  await callers[0].open();
  expect(dialogs()).toHaveLength(1);
  expect(alertText()).toBeNull();
});
