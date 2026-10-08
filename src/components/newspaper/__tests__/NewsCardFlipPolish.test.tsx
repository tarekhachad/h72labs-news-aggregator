// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card } from "@/types";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";
import { MIN_FLIP_PERSPECTIVE_PX, flipPerspectivePx } from "@/lib/flipPerspective";

function makeCard(): Card {
  return {
    id: "card-1",
    topic: "Tech/AI",
    title: "A headline",
    shortSummary: "A short summary of the story.",
    labels: [],
    expandedReport: "A report.",
    sources: [
      { source: "BBC", title: "First story", url: "https://a.example/1", snippet: "" },
      { source: "NYT", title: "Last story", url: "https://b.example/2", snippet: "" },
    ],
    publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: false,
    severity: 3,
    frontPageRank: 1,
  };
}

/** Every ResizeObserver the card creates, so a test can fire one by hand and see what it watches. */
type FakeObserver = { callback: () => void; observed: Element[]; disconnected: boolean };
let observers: FakeObserver[];
/** The layout size jsdom reports for every element (it does no layout of its own). */
let layoutSize: { width: number; height: number };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  observers = [];
  layoutSize = { width: 0, height: 0 };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private record: FakeObserver;
      constructor(callback: () => void) {
        this.record = { callback, observed: [], disconnected: false };
        observers.push(this.record);
      }
      observe(el: Element) {
        this.record.observed.push(el);
      }
      disconnect() {
        this.record.disconnected = true;
      }
    }
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => layoutSize.width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => layoutSize.height);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(
      <FocusModeProvider>
        <NewsCard card={makeCard()} tier="hero" showTopicBadge />
      </FocusModeProvider>
    );
  });
}

function cardElement(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="button"]');
  if (!el) throw new Error("card element not rendered");
  return el;
}

/** The two faces, front first: the absolutely-positioned children of the flipper. */
function faces(): HTMLElement[] {
  const flipper = cardElement().firstElementChild as HTMLElement;
  return Array.from(flipper.children) as HTMLElement[];
}

/** Live observers watching the card's own outer element. */
function cardObservers(el: HTMLElement): FakeObserver[] {
  return observers.filter((o) => !o.disconnected && o.observed.includes(el));
}

describe("NewsCard flip depth", () => {
  it("uses today's 1200 px before the card has a layout size", async () => {
    await render();
    expect(cardElement().style.perspective).toBe(`${MIN_FLIP_PERSPECTIVE_PX}px`);
  });

  it("sets the perspective from the card's own layout size on mount", async () => {
    layoutSize = { width: 1360, height: 380 };
    await render();
    expect(cardElement().style.perspective).toBe(`${flipPerspectivePx(1360, 380)}px`);
    expect(flipPerspectivePx(1360, 380)).toBeGreaterThan(MIN_FLIP_PERSPECTIVE_PX);
  });

  it("follows a resize of the card", async () => {
    layoutSize = { width: 1360, height: 380 };
    await render();
    const el = cardElement();
    const [observer] = cardObservers(el);
    expect(observer).toBeDefined();

    layoutSize = { width: 1840, height: 380 };
    await act(async () => observer.callback());
    expect(el.style.perspective).toBe(`${flipPerspectivePx(1840, 380)}px`);
  });

  it("re-observes the new element after focus mode closes", async () => {
    layoutSize = { width: 670, height: 380 };
    await render();
    const before = cardElement();
    expect(cardObservers(before)).toHaveLength(1);

    await act(async () => before.click());
    expect(container.querySelector('[role="button"]')).toBeNull();
    // The swapped-out element's observer is released, not left watching a detached node.
    expect(cardObservers(before)).toHaveLength(0);

    const close = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label")?.toLowerCase().includes("close") || b.textContent?.toLowerCase().includes("close")
    );
    expect(close).toBeDefined();
    await act(async () => close!.click());

    const after = cardElement();
    expect(after).not.toBe(before);
    const [observer] = cardObservers(after);
    expect(observer).toBeDefined();
    layoutSize = { width: 1360, height: 380 };
    await act(async () => observer.callback());
    expect(after.style.perspective).toBe(`${flipPerspectivePx(1360, 380)}px`);
  });
});

describe("NewsCard vertical flip", () => {
  it("pre-rotates the back face on the horizontal axis", async () => {
    await render();
    const [front, back] = faces();
    expect(back.style.transform).toBe("rotateX(180deg)");
    expect(front.style.transform).toBe("");
    expect(front.style.backfaceVisibility).toBe("hidden");
    expect(back.style.backfaceVisibility).toBe("hidden");
  });

  it("turns the flipper on rotateX, never rotateY", async () => {
    await render();
    const flipper = cardElement().firstElementChild as HTMLElement;
    const sources = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Sources")
    );
    await act(async () => sources!.click());
    await vi.waitFor(() => expect(flipper.style.transform).toContain("rotateX(180deg)"), { timeout: 2000 });
    expect(flipper.style.transform).not.toContain("rotateY");
  });
});

describe("NewsCard hover border", () => {
  it("darkens both faces' border on the card's hover and keyboard focus, colour only", async () => {
    await render();
    expect(cardElement().className.split(/\s+/)).toContain("group/card");
    for (const face of faces()) {
      const classes = face.className.split(/\s+/);
      expect(classes).toContain("border");
      expect(classes).toContain("border-[var(--color-border)]");
      expect(classes).toContain("group-hover/card:border-[var(--color-foreground)]");
      expect(classes).toContain("group-focus-visible/card:border-[var(--color-foreground)]");
      expect(classes).toContain("transition-[border-color]");
      expect(classes).toContain("duration-200");
      expect(classes).toContain("ease-out");
      expect(face.className).not.toMatch(/shadow|scale|translate|ring-/);
      // An inline border would outrank the hover class and pin the colour.
      expect(face.style.border).toBe("");
      expect(face.style.borderColor).toBe("");
    }
  });

  it("puts nothing on hover on the outer element, which carries layoutId and the entrance scale", async () => {
    await render();
    expect(cardElement().className).not.toMatch(/hover:|focus-visible:/);
  });
});

describe("NewsCard sources list", () => {
  it("leaves bottom room so the last link's hover underline isn't clipped", async () => {
    await render();
    const list = container.querySelector("ul");
    expect(list).not.toBeNull();
    const classes = list!.className.split(/\s+/);
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("pb-1");
  });
});
