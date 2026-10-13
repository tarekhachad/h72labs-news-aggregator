// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SavedCard } from "@/lib/bookmarks";
import type { Topic } from "@/types";
import { SavedList } from "@/app/(paper)/saved/SavedList";

// Where keyboard focus lands after a confirmed removal: the card that took
// the removed one's place, the one before it when the last card went, or the
// page heading when no card is left showing. Without this it fell to <body>.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let main: HTMLElement;
let heading: HTMLHeadingElement;
let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  // The page's own shape: the heading sits in <main> beside the list.
  main = document.createElement("main");
  heading = document.createElement("h1");
  heading.textContent = "Saved";
  container = document.createElement("div");
  main.append(heading, container);
  document.body.appendChild(main);
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

const button = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector('[role="dialog"]');
/** The card whose title is `Title <id>`: its root, the focusable role="button". */
const cardRoot = (id: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]')].find((el) =>
    el.textContent?.includes(`Title ${id}`)
  );

async function render(cards: SavedCard[] = CARDS) {
  await act(async () => root.render(<SavedList initialCards={cards} />));
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => el.click());
}

/** Opens card `id`'s Remove dialog and confirms it. */
async function remove(id: string) {
  await click(button("★ Saved", cardRoot(id)!));
  await click(button("Remove", dialog()!));
}

describe("focus after removing a saved card", () => {
  it("moves to the card that took its place", async () => {
    await render();
    await remove("a");
    expect(cardRoot("a")).toBeUndefined();
    expect(document.activeElement).toBe(cardRoot("b"));
  });

  it("moves to the next card when a middle one goes", async () => {
    await render();
    await remove("b");
    expect(document.activeElement).toBe(cardRoot("c"));
  });

  it("moves to the previous card when the last one goes", async () => {
    await render();
    await remove("c");
    expect(document.activeElement).toBe(cardRoot("b"));
  });

  it("moves to the page heading when the only card goes, without adding it to the Tab order", async () => {
    await render([CARDS[0]]);
    await remove("a");
    expect(container.textContent).toContain("Nothing saved yet.");
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);
  });

  it("moves to the page heading when a filter leaves no card showing", async () => {
    await render();
    const input = [...container.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith("To"))!
      .querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "2026-10-05");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await remove("b");
    expect(container.textContent).toContain("No saved cards match these filters.");
    expect(document.activeElement).toBe(heading);
  });

  it("does it again on a second removal in a row", async () => {
    await render();
    await remove("a");
    await remove("b");
    expect(document.activeElement).toBe(cardRoot("c"));
  });

  it("stays in the dialog when the removal fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await render();
    await remove("a");
    expect(dialog()).not.toBeNull();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it("leaves Cancel returning focus to Save", async () => {
    await render();
    const save = button("★ Saved", cardRoot("b")!)!;
    await click(save);
    await click(button("Cancel", dialog()!));
    expect(document.activeElement).toBe(save);
  });
});
