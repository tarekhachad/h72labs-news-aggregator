// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The sidebar's admin badge: a count from pending_invite_request_count
// shows the admin link (and a dot when there is something pending); null,
// the answer for every other reader, shows nothing; and a slow lookup never
// holds up the menu.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/app/auth/actions", () => ({ signOutAction: vi.fn() }));

const { Sidebar } = await import("@/components/newspaper/Sidebar");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function render(pendingRequests?: Promise<number | null>) {
  await act(async () => root.render(<Sidebar pendingRequests={pendingRequests} />));
}

async function openMenu() {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!;
  await act(async () => trigger.click());
}

const dot = () => document.querySelector('[data-testid="pending-requests-dot"]');
const adminLink = () => [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/admin/requests");

describe("Sidebar admin badge", () => {
  it("shows the dot and a counted link for an admin with pending requests", async () => {
    await render(Promise.resolve(3));
    expect(dot()).not.toBeNull();
    expect(dot()!.getAttribute("aria-hidden")).toBe("true");
    await openMenu();
    const link = adminLink()!;
    expect(link).toBeDefined();
    expect(link.textContent).toContain("Invite requests");
    expect(link.textContent).toContain("3");
  });

  it("shows the link with no dot and no count when nothing is pending", async () => {
    await render(Promise.resolve(0));
    expect(dot()).toBeNull();
    await openMenu();
    const link = adminLink()!;
    expect(link).toBeDefined();
    expect(link.textContent!.trim()).toBe("Invite requests");
  });

  it("shows neither to a reader who is not an admin", async () => {
    await render(Promise.resolve(null));
    expect(dot()).toBeNull();
    await openMenu();
    expect(adminLink()).toBeUndefined();
    // The rest of the menu is intact.
    expect(document.querySelector('a[href="/saved"]')).not.toBeNull();
  });

  it("shows neither when no promise is passed (pages outside the paper layout)", async () => {
    await render(undefined);
    await openMenu();
    expect(adminLink()).toBeUndefined();
    expect(document.querySelector('a[href="/profile"]')).not.toBeNull();
  });

  it("does not hold up the menu while the count is still loading", async () => {
    let resolve!: (n: number | null) => void;
    await render(new Promise((r) => (resolve = r)));
    expect(document.querySelector('button[aria-label="Open menu"]')).not.toBeNull();
    await openMenu();
    expect(document.querySelector('a[href="/history"]')).not.toBeNull();
    expect(adminLink()).toBeUndefined();
    await act(async () => resolve(2));
    expect(adminLink()).toBeDefined();
    expect(dot()).not.toBeNull();
  });
});
