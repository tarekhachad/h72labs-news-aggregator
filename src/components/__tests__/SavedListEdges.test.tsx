// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SavedCard } from "@/lib/bookmarks";

// Unsaving a card plays an exit that collapses its height and its own bottom
// margin. What must not happen is a *neighbour's* margin changing in a single
// frame when the exiting card's DOM node is finally removed — which is what a
// position-dependent rule like `last:mb-0` does the moment the neighbour
// becomes the last child.
//
// jsdom has no layout, but it does run the CSS cascade for getComputedStyle,
// including `:last-child`. So the Tailwind rules that decide this list's
// spacing are declared below with Tailwind's own selectors and values, and
// the test reads computed margins rather than class names.
//
// requestAnimationFrame is a hand-flushed queue so the exit can be stepped
// through; it must be installed before motion is first imported (see
// NewsCardEntrance.test.tsx for the same setup).
const frames = vi.hoisted(() => {
  const queue: FrameRequestCallback[] = [];
  const state = { now: 0 };
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  return { queue, state };
});

import { SavedList } from "@/app/(paper)/saved/SavedList";

const TAILWIND_SPACING_RULES = `
  .mb-4 { margin-bottom: 16px; }
  .-mb-4 { margin-bottom: -16px; }
  .last\\:mb-0:last-child { margin-bottom: 0px; }
`;

const FRAME_MS = 1000 / 60;

async function flushFrames(count: number) {
  for (let i = 0; i < count; i++) {
    frames.state.now += FRAME_MS;
    const batch = frames.queue.splice(0);
    await act(async () => {
      batch.forEach((cb) => cb(frames.state.now));
    });
  }
}

function makeCard(id: string): SavedCard {
  return {
    id,
    topic: "Tech/AI",
    title: `Headline ${id}`,
    shortSummary: `Summary ${id}`,
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: true,
    severity: 3,
    frontPageRank: null,
    date: "2026-10-01",
  };
}

let container: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

beforeEach(() => {
  vi.spyOn(performance, "now").mockImplementation(() => frames.state.now);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 }))
  );
  style = document.createElement("style");
  style.textContent = TAILWIND_SPACING_RULES;
  document.head.appendChild(style);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await flushFrames(5);
  container.remove();
  style.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function list(): HTMLElement {
  const el = container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("list not rendered");
  return el;
}

function items(): HTMLElement[] {
  return Array.from(list().children) as HTMLElement[];
}

function marginBottom(el: Element): string {
  return getComputedStyle(el).marginBottom;
}

async function unsave(item: HTMLElement) {
  const button = Array.from(item.querySelectorAll("button")).find((b) => b.textContent?.includes("Saved"));
  if (!button) throw new Error("save button not found");
  await act(async () => {
    button.click();
  });
}


describe("SavedList spacing, extra edges", () => {
  async function renderN(ids: string[]) {
    await act(async () => { root.render(<SavedList initialCards={ids.map(makeCard)} />); });
  }
  it("removing the first card keeps every remaining margin at 16px throughout", async () => {
    await renderN(["a", "b", "c"]);
    const [a, b, c] = items();
    await unsave(a);
    for (let i = 0; i < 30; i++) {
      await flushFrames(1);
      expect(marginBottom(b)).toBe("16px");
      expect(marginBottom(c)).toBe("16px");
    }
    expect(items()).toEqual([b, c]);
  });
  it("removing a middle card keeps neighbours at 16px", async () => {
    await renderN(["a", "b", "c"]);
    const [a, b, c] = items();
    await unsave(b);
    for (let i = 0; i < 30; i++) {
      await flushFrames(1);
      expect(marginBottom(a)).toBe("16px");
      expect(marginBottom(c)).toBe("16px");
    }
    expect(items()).toEqual([a, c]);
  });
  it("rapid unsave of last two cards: survivor margin never changes, ends with empty state at 16px", async () => {
    await renderN(["a", "b", "c"]);
    const [a, b, c] = items();
    await unsave(c);
    await flushFrames(2);
    await unsave(b);
    for (let i = 0; i < 40; i++) {
      await flushFrames(1);
      expect(marginBottom(a)).toBe("16px");
    }
    await unsave(a);
    await flushFrames(40);
    expect(items().length).toBe(1);
    expect(items()[0].textContent).toBe("Nothing saved yet.");
    expect(marginBottom(items()[0])).toBe("16px");
  });
});
