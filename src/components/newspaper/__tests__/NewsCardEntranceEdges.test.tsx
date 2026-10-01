// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card } from "@/types";

// The entrance runs on Motion's frameloop, which is driven by
// requestAnimationFrame. A hidden browser tab never fires rAF, while the
// provider's backstop timer (wall-clock) still does — so a card can be retired
// before its entrance has played a single frame. To reproduce that here, rAF
// is replaced with a queue this file flushes by hand: holding the queue is a
// hidden tab, flushing it is the reader coming back.
//
// Motion captures `requestAnimationFrame` when its frameloop module is first
// evaluated, so the stub has to be installed before any import of motion —
// vi.hoisted runs ahead of the static imports below.
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

import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";

const FRAME_MS = 1000 / 60;

/** Runs every queued frame callback, `count` times over, advancing the clock one frame each time. */
async function flushFrames(count: number) {
  for (let i = 0; i < count; i++) {
    frames.state.now += FRAME_MS;
    const batch = frames.queue.splice(0);
    await act(async () => {
      batch.forEach((cb) => cb(frames.state.now));
    });
  }
}

function makeCard(): Card {
  return {
    id: "card-1",
    topic: "Tech/AI",
    title: "A headline",
    shortSummary: "A short summary of the story.",
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-01T12:00:00Z",
    generatedAt: "2026-10-01T12:00:00Z",
    bookmarked: false,
    severity: 3,
    frontPageRank: 1,
  };
}

let container: HTMLDivElement;
let root: Root;
// Every inline opacity the card's element carries, from its first render
// onward — so "never invisible" is checked at each step, not just at the end.
let seenOpacities: string[];
let observer: MutationObserver | null;

// The queue is drained between tests, never cleared: Motion's frameloop
// requests one frame and then waits for it, so discarding a pending callback
// would leave every later test's animations waiting forever. The clock only
// moves forward for the same reason.
beforeEach(() => {
  vi.spyOn(performance, "now").mockImplementation(() => frames.state.now);
  // jsdom has no ResizeObserver; useDynamicLineClamp needs one to exist.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  seenOpacities = [];
  observer = null;
});

afterEach(async () => {
  observer?.disconnect();
  await act(async () => root.unmount());
  await flushFrames(5);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function cardElement(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="button"]');
  if (!el) throw new Error("card element not rendered");
  return el;
}

function watchOpacity(el: HTMLElement) {
  seenOpacities.push(el.style.opacity);
  observer = new MutationObserver(() => seenOpacities.push(el.style.opacity));
  observer.observe(el, { attributes: true, attributeFilter: ["style"] });
}

/** Natural size: no scale left in the inline transform (Motion writes `none` at identity). */
function expectNaturalSize(el: HTMLElement) {
  expect(el.style.transform === "" || el.style.transform === "none").toBe(true);
}

function expectNeverInvisible() {
  // "" means no inline opacity at all, i.e. the stylesheet's full opacity.
  expect(seenOpacities.every((o) => o === "" || o === "1")).toBe(true);
}


async function renderWith(props: { animateEntrance: boolean; entranceDelay: number; strict?: boolean }) {
  const node = (
    <FocusModeProvider>
      <NewsCard card={makeCard()} tier="medium" showTopicBadge animateEntrance={props.animateEntrance} entranceDelay={props.entranceDelay} />
    </FocusModeProvider>
  );
  await act(async () => {
    root.render(props.strict ? <StrictMode>{node}</StrictMode> : node);
  });
}

describe("NewsCard entrance, extra edges", () => {
  it("retired during a nonzero stagger delay still ends visible and at natural size", async () => {
    await renderWith({ animateEntrance: true, entranceDelay: 0.5 });
    const el = cardElement();
    watchOpacity(el);
    await flushFrames(5);
    await renderWith({ animateEntrance: false, entranceDelay: 0.5 });
    await flushFrames(120);
    expectNaturalSize(el);
    expectNeverInvisible();
  });

  it("delayed entrance that plays out fully ends natural size, never invisible", async () => {
    await renderWith({ animateEntrance: true, entranceDelay: 0.3 });
    const el = cardElement();
    watchOpacity(el);
    expect(el.style.transform).toContain("scale(0.97)");
    await flushFrames(120);
    expectNaturalSize(el);
    expectNeverInvisible();
  });

  it("works under StrictMode (double mount) and retires cleanly", async () => {
    await renderWith({ animateEntrance: true, entranceDelay: 0, strict: true });
    const el = cardElement();
    watchOpacity(el);
    await flushFrames(6);
    await renderWith({ animateEntrance: false, entranceDelay: 0, strict: true });
    await flushFrames(60);
    expectNaturalSize(el);
    expectNeverInvisible();
  });

  it("unmount mid-entrance then fresh remount with entrance off renders natural size", async () => {
    await renderWith({ animateEntrance: true, entranceDelay: 0 });
    await flushFrames(5);
    await act(async () => root.render(<div />));
    await flushFrames(5);
    await renderWith({ animateEntrance: false, entranceDelay: 0 });
    const el = cardElement();
    watchOpacity(el);
    await flushFrames(40);
    expectNaturalSize(el);
    expectNeverInvisible();
  });

  it("opening focus mode mid-entrance and closing leaves card visible and natural", async () => {
    await renderWith({ animateEntrance: true, entranceDelay: 0 });
    let el = cardElement();
    await flushFrames(4);
    await act(async () => { el.click(); });
    await flushFrames(10);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flushFrames(60);
    await renderWith({ animateEntrance: false, entranceDelay: 0 });
    await flushFrames(60);
    el = cardElement();
    expectNaturalSize(el);
    expect(el.style.opacity === "" || el.style.opacity === "1").toBe(true);
  });
});
