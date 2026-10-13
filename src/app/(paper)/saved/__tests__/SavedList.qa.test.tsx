// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { SavedCard } from "@/lib/bookmarks";
import type { Topic } from "@/types";
import { SavedList } from "@/app/(paper)/saved/SavedList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

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
  vi.useRealTimers();
});

function saved(id: string, topic: string, date: string): SavedCard {
  return {
    id, topic: topic as Topic, title: `Title ${id}`, shortSummary: "S.", labels: [], expandedReport: null,
    sources: [], publishedAt: "2026-10-01T12:00:00Z", generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: true, severity: 3, frontPageRank: null, date,
  };
}
const titles = () => [...container.querySelectorAll("p")].map((p) => p.textContent).filter((t) => t?.startsWith("Title "));
const btn = (name: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const dialog = () => document.querySelector('[role="dialog"]');
const render = (cards: SavedCard[]) => act(async () => root.render(<SavedList initialCards={cards} />));
const click = (el: HTMLElement) => act(async () => el.click());
async function setDate(label: string, value: string) {
  const input = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label))!.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("SavedList QA", () => {
  it("date bounds are inclusive on both ends", async () => {
    await render([saved("a", "Tech/AI", "2026-10-12"), saved("b", "Football", "2026-10-03")]);
    await setDate("From", "2026-10-03");
    await setDate("To", "2026-10-12");
    expect(titles()).toEqual(["Title a", "Title b"]);
  });

  it("cards without a date are excluded by a date bound but show no 'From' note", async () => {
    await render([saved("a", "Tech/AI", ""), saved("b", "Tech/AI", "2026-10-03")]);
    expect(container.textContent).not.toContain("From undefined");
    expect(container.textContent).not.toContain("Invalid");
    await setDate("From", "2026-10-01");
    expect(titles()).toEqual(["Title b"]);
  });

  it("topic + date filters combine; Clear filters resets all", async () => {
    await render([saved("a", "Tech/AI", "2026-10-12"), saved("b", "Football", "2026-10-12"), saved("c", "Tech/AI", "2026-10-01")]);
    await click(btn("Tech/AI"));
    await setDate("From", "2026-10-10");
    expect(titles()).toEqual(["Title a"]);
    expect(container.textContent).toContain("1 of 3 saved");
    await click(btn("Clear filters"));
    expect(titles()).toHaveLength(3);
    expect(btn("Clear filters")).toBeUndefined();
  });

  it("removing the only visible card under a date filter shows empty-match message, count updates", async () => {
    await render([saved("a", "Tech/AI", "2026-10-12"), saved("b", "Tech/AI", "2026-10-01")]);
    await setDate("From", "2026-10-12");
    await click(btn("★ Saved"));
    await click(btn("Remove", dialog()! as HTMLElement));
    expect(container.textContent).toContain("No saved cards match these filters.");
    expect(container.textContent).toContain("0 of 1 saved");
    await click(btn("Clear filters"));
    expect(titles()).toEqual(["Title b"]);
  });

  it("removing the last card shows the empty state", async () => {
    await render([saved("a", "Tech/AI", "2026-10-12")]);
    await click(btn("★ Saved"));
    await click(btn("Remove", dialog()! as HTMLElement));
    expect(container.textContent).toContain("Nothing saved yet.");
    expect(dialog()).toBeNull();
  });

  it("only the removed card goes; others keep order (removing middle card)", async () => {
    await render([saved("a", "Tech/AI", "2026-10-12"), saved("b", "Football", "2026-10-11"), saved("c", "Tech/AI", "2026-10-10")]);
    const saves = [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "★ Saved");
    await click(saves[1]);
    await click(btn("Remove", dialog()! as HTMLElement));
    expect(fetchMock).toHaveBeenCalledWith("/api/bookmarks", expect.objectContaining({ body: JSON.stringify({ cardId: "b" }) }));
    expect(titles()).toEqual(["Title a", "Title c"]);
  });

  it("failed removal while filtered keeps the card and filter", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await render([saved("a", "Tech/AI", "2026-10-12"), saved("b", "Football", "2026-10-11")]);
    await click(btn("Football"));
    await click(btn("★ Saved"));
    await click(btn("Remove", dialog()! as HTMLElement));
    await click(btn("Cancel", dialog()! as HTMLElement));
    expect(titles()).toEqual(["Title b"]);
    expect(btn("Football").getAttribute("aria-pressed")).toBe("true");
  });

  it("topics are alphabetical, All first; grid is 2-col md / 1-col base", async () => {
    await render([saved("a", "Tech/AI", "2026-10-12"), saved("b", "Football", "2026-10-11"), saved("c", "Business", "2026-10-10")]);
    const names = [...container.querySelectorAll("nav button")].map((b) => b.textContent);
    expect(names).toEqual(["All", "Business", "Football", "Tech/AI"]);
    const grid = container.querySelector(".grid")!;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("md:grid-cols-2");
  });

  it("date note is timezone-independent (SSR text equals client text)", async () => {
    const cards = [saved("a", "Tech/AI", "2026-10-01"), saved("b", "Tech/AI", "2026-12-31")];
    const html = renderToString(<SavedList initialCards={cards} />);
    expect(html).toContain("From Oct 1, 2026");
    expect(html).toContain("From Dec 31, 2026");
    await render(cards);
    expect(container.textContent).toContain("From Oct 1, 2026");
    expect(container.textContent).toContain("From Dec 31, 2026");
  });

  it("hydrates SSR output without mismatch warnings", async () => {
    const cards = [saved("a", "Tech/AI", "2026-10-01")];
    const html = renderToString(<SavedList initialCards={cards} />);
    const el = document.createElement("div");
    el.innerHTML = html;
    document.body.appendChild(el);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { hydrateRoot } = await import("react-dom/client");
    await act(async () => { hydrateRoot(el, <SavedList initialCards={cards} />); });
    const mismatch = err.mock.calls.filter((c) => String(c[0]).toLowerCase().includes("hydrat"));
    err.mockRestore();
    expect(mismatch).toEqual([]);
  });

  it("focus returns to Save after Cancel, even with a second card", async () => {
    await render([saved("a", "Tech/AI", "2026-10-12"), saved("b", "Football", "2026-10-11")]);
    const saves = [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "★ Saved");
    await click(saves[1]);
    await click(btn("Cancel", dialog()! as HTMLElement));
    expect(document.activeElement).toBe(saves[1]);
  });
});
