// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card } from "@/types";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function makeCard(bookmarked: boolean): Card {
  return {
    id: "c1", topic: "Tech/AI", title: "Headline", shortSummary: "Sum.", labels: [],
    expandedReport: null, sources: [], publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z", bookmarked, severity: 3, frontPageRank: 1,
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

type Props = Partial<React.ComponentProps<typeof NewsCard>>;
async function render(bookmarked: boolean, props: Props = {}) {
  await act(async () =>
    root.render(
      <FocusModeProvider>
        <NewsCard card={makeCard(bookmarked)} tier="medium" showTopicBadge {...props} />
      </FocusModeProvider>
    )
  );
}
const btn = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const dialog = () => document.querySelector('[role="dialog"]');
const click = (el: HTMLElement) => act(async () => el.click());
function deferred() {
  let resolve!: (r: Response) => void;
  const p = new Promise<Response>((r) => (resolve = r));
  return { p, resolve };
}

describe("NewsCard unsave: default behaviour (no confirmUnsave)", () => {
  it("un-saves optimistically with no dialog, with and without onBookmarkChange", async () => {
    const d = deferred();
    fetchMock.mockReturnValueOnce(d.p);
    const spy = vi.fn();
    await render(true, { onBookmarkChange: spy });
    await click(btn("★ Saved", container));
    expect(dialog()).toBeNull();
    expect(btn("☆ Save", container)).toBeTruthy(); // optimistic, before server replies
    expect(spy).not.toHaveBeenCalled();
    await act(async () => d.resolve(new Response("{}", { status: 200 })));
    expect(spy).toHaveBeenCalledWith("c1", false);
  });

  it("reverts and does not notify on failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const spy = vi.fn();
    await render(true, { onBookmarkChange: spy });
    await click(btn("★ Saved", container));
    expect(btn("★ Saved", container)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("reverts on network rejection", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await render(true);
    await click(btn("★ Saved", container));
    expect(btn("★ Saved", container)).toBeTruthy();
  });

  it("saving (POST) never asks, even with confirmUnsave, and notifies", async () => {
    const spy = vi.fn();
    await render(false, { confirmUnsave: true, onBookmarkChange: spy });
    await click(btn("☆ Save", container));
    expect(dialog()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/bookmarks", expect.objectContaining({ method: "POST" }));
    expect(spy).toHaveBeenCalledWith("c1", true);
  });

  it("works without onBookmarkChange", async () => {
    await render(false);
    await click(btn("☆ Save", container));
    expect(btn("★ Saved", container)).toBeTruthy();
  });

  it("rapid double click on Save sends one request", async () => {
    const d = deferred();
    fetchMock.mockReturnValueOnce(d.p);
    await render(false);
    const b = btn("☆ Save", container);
    await click(b); await click(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(new Response("{}")));
  });
});

describe("NewsCard unsave: confirmUnsave", () => {
  it("shows dialog, Cancel focused, Remove destructive; no fetch yet", async () => {
    await render(true, { confirmUnsave: true });
    await click(btn("★ Saved", container));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
    expect(dialog()?.textContent).toContain("Remove from Saved?");
    // still shown as saved behind dialog
    expect(btn("★ Saved", container)).toBeTruthy();
  });

  it("is not optimistic: card stays saved while the DELETE is pending, and a second Remove click sends once", async () => {
    const d = deferred();
    fetchMock.mockReturnValueOnce(d.p);
    const spy = vi.fn();
    await render(true, { confirmUnsave: true, onBookmarkChange: spy });
    await click(btn("★ Saved", container));
    const remove = btn("Remove", dialog()!);
    await click(remove); await click(remove);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(btn("★ Saved", container)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    expect(btn("Cancel", dialog()!).disabled).toBe(true);
    await act(async () => d.resolve(new Response("{}")));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("c1", false);
    expect(dialog()).toBeNull();
    expect(btn("☆ Save", container)).toBeTruthy();
  });

  it("Escape and backdrop are ignored while removal is pending", async () => {
    const d = deferred();
    fetchMock.mockReturnValueOnce(d.p);
    await render(true, { confirmUnsave: true });
    await click(btn("★ Saved", container));
    await click(btn("Remove", dialog()!));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).not.toBeNull();
    const backdrop = document.querySelector("[aria-hidden='true'], [data-backdrop]") as HTMLElement | null;
    if (backdrop) await click(backdrop);
    expect(dialog()).not.toBeNull();
    await act(async () => d.resolve(new Response("{}")));
    expect(dialog()).toBeNull();
  });

  it("Escape cancels when idle, restores focus to Save, sends nothing", async () => {
    const spy = vi.fn();
    await render(true, { confirmUnsave: true, onBookmarkChange: spy });
    await click(btn("★ Saved", container));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(btn("★ Saved", container));
  });

  it("failure keeps dialog + error; retry succeeds; cancel after failure clears error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const spy = vi.fn();
    await render(true, { confirmUnsave: true, onBookmarkChange: spy });
    await click(btn("★ Saved", container));
    await click(btn("Remove", dialog()!));
    expect(dialog()?.textContent).toContain("Couldn't remove it.");
    expect(spy).not.toHaveBeenCalled();
    expect(btn("Remove", dialog()!).disabled).toBe(false);
    await click(btn("Cancel", dialog()!));
    expect(dialog()).toBeNull();
    // reopen: stale error must be gone
    await click(btn("★ Saved", container));
    expect(dialog()?.textContent).not.toContain("Couldn't remove it.");
    await click(btn("Remove", dialog()!));
    expect(spy).toHaveBeenCalledWith("c1", false);
  });

  it("network rejection shows the error too", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await render(true, { confirmUnsave: true });
    await click(btn("★ Saved", container));
    await click(btn("Remove", dialog()!));
    expect(dialog()?.textContent).toContain("Couldn't remove it.");
  });

  it("a click inside the dialog does not open focus mode", async () => {
    await render(true, { confirmUnsave: true });
    await click(btn("★ Saved", container));
    await click(dialog()!.querySelector("h2") as HTMLElement);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("dateNote replaces the relative time; absent leaves relative time", async () => {
    await render(true, { dateNote: "From Oct 12, 2026" });
    expect(container.textContent).toContain("From Oct 12, 2026");
    expect(container.textContent).not.toMatch(/\d+[dhm] ago/);
  });
});
