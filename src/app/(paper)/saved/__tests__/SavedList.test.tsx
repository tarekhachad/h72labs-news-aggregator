// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SavedCard } from "@/lib/bookmarks";
import type { Topic } from "@/types";
import { SavedList } from "@/app/(paper)/saved/SavedList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom has no ResizeObserver; NewsCard's line clamp and flip depth need one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
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

function saved(id: string, topic: string, date: string): SavedCard {
  return {
    id,
    topic: topic as Topic,
    title: `Title ${id}`,
    shortSummary: "Summary.",
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: true,
    severity: 3,
    frontPageRank: null,
    date,
  };
}

const CARDS = [saved("a", "Tech/AI", "2026-10-12"), saved("b", "Football", "2026-10-03"), saved("c", "Tech/AI", "2026-10-09")];

const titles = () => [...container.querySelectorAll("p")].map((p) => p.textContent).filter((t) => t?.startsWith("Title "));
const button = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector('[role="dialog"]');

async function render(cards: SavedCard[] = CARDS) {
  await act(async () => root.render(<SavedList initialCards={cards} />));
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => el.click());
}

// React tracks an input's value itself, so a test has to go through the
// native setter for onChange to see the new value.
async function setDate(label: string, value: string) {
  const input = [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SavedList", () => {
  it("shows every card as a newspaper card, newest-saved first, with its day", async () => {
    await render();
    expect(titles()).toEqual(["Title a", "Title b", "Title c"]);
    expect(container.textContent).toContain("From Oct 12, 2026");
    expect(container.textContent).toContain("3 saved");
  });

  it("says how to save when nothing is saved", async () => {
    await render([]);
    expect(container.textContent).toContain("Nothing saved yet.");
    expect(container.querySelector("nav")).toBeNull();
  });

  it("filters by topic and back to All", async () => {
    await render();
    await click(button("Tech/AI", container));
    expect(titles()).toEqual(["Title a", "Title c"]);
    expect(button("Tech/AI", container)?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("2 of 3 saved");
    await click(button("All", container));
    expect(titles()).toEqual(["Title a", "Title b", "Title c"]);
  });

  it("filters by a date range, a single day, and clears", async () => {
    await render();
    await setDate("From", "2026-10-04");
    expect(titles()).toEqual(["Title a", "Title c"]);
    await setDate("To", "2026-10-10");
    expect(titles()).toEqual(["Title c"]);
    await setDate("From", "2026-10-12");
    expect(container.textContent).toContain("The From date is after the To date.");
    await click(button("Just that day", container));
    expect(titles()).toEqual(["Title a"]);
    await click(button("Clear filters", container));
    expect(titles()).toEqual(["Title a", "Title b", "Title c"]);
  });

  it("asks before removing, and Cancel keeps the card and sends nothing", async () => {
    await render();
    await click(button("★ Saved", container));
    expect(dialog()?.textContent).toContain("Remove from Saved?");
    await click(button("Cancel", dialog()!));
    expect(dialog()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(titles()).toHaveLength(3);
    expect(document.activeElement?.textContent?.trim()).toBe("★ Saved");
  });

  it("removes the card once the reader confirms and the server agrees", async () => {
    await render();
    await click(button("★ Saved", container));
    await click(button("Remove", dialog()!));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bookmarks",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ cardId: "a" }) })
    );
    expect(dialog()).toBeNull();
    expect(titles()).toEqual(["Title b", "Title c"]);
    expect(container.textContent).toContain("2 saved");
  });

  it("keeps the dialog open with a message when the removal fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await render();
    await click(button("★ Saved", container));
    await click(button("Remove", dialog()!));
    expect(dialog()?.textContent).toContain("Couldn't remove it.");
    expect(titles()).toHaveLength(3);
  });

  it("falls back to All when the filtered topic's last card is removed", async () => {
    await render();
    await click(button("Football", container));
    await click(button("★ Saved", container));
    await click(button("Remove", dialog()!));
    expect(button("Football", container)).toBeUndefined();
    expect(button("All", container)?.getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toEqual(["Title a", "Title c"]);
  });

  it("does not open focus mode from a click inside the dialog", async () => {
    await render();
    await click(button("★ Saved", container));
    await click(button("Cancel", dialog()!));
    // Focus mode's overlay is a dialog too; none should be open.
    expect(dialog()).toBeNull();
  });
});
