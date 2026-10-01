// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TransitionStage } from "@/components/newspaper/PageTransitionContext";

// The boundary derives everything from the transition `stage`, so the test
// drives that directly instead of running the real flip state machine.
const transition = vi.hoisted(() => ({ stage: "idle" as TransitionStage }));

vi.mock("@/components/newspaper/PageTransitionContext", () => ({
  usePageTransitionState: () => ({ stage: transition.stage, flipCount: 1 }),
}));

import { PageTransitionInertBoundary } from "@/components/newspaper/PageTransitionInertBoundary";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  transition.stage = "idle";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderAt(stage: TransitionStage) {
  transition.stage = stage;
  await act(async () => {
    root.render(
      <PageTransitionInertBoundary
        masthead={
          <header data-testid="masthead">
            <button>Menu</button>
          </header>
        }
      >
        <main data-testid="page">
          <button>First control on the page</button>
        </main>
      </PageTransitionInertBoundary>
    );
  });
}

function byTestId(id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`${id} not rendered`);
  return el;
}

/** True when the element sits inside an inert subtree (or is inert itself). */
function isInert(el: HTMLElement): boolean {
  return el.closest("[inert]") !== null;
}

describe("PageTransitionInertBoundary", () => {
  it("marks both the masthead and the page inert while a flip is in flight", async () => {
    await renderAt("idle");
    expect(isInert(byTestId("masthead"))).toBe(false);
    expect(isInert(byTestId("page"))).toBe(false);

    for (const stage of ["zooming-out", "flipping", "zooming-in"] as const) {
      await renderAt(stage);
      expect(isInert(byTestId("masthead"))).toBe(true);
      expect(isInert(byTestId("page"))).toBe(true);
    }
  });

  it("moves focus to the page content, below the masthead, once the flip lands", async () => {
    await renderAt("idle");
    await renderAt("zooming-out");
    await renderAt("flipping");
    await renderAt("zooming-in");
    await renderAt("idle");

    const focused = document.activeElement as HTMLElement;
    const page = byTestId("page");
    const masthead = byTestId("masthead");
    // The focus target is the page's own wrapper: it contains the page and
    // not the masthead, so the next Tab goes into the page.
    expect(focused.contains(page)).toBe(true);
    expect(focused.contains(masthead)).toBe(false);
    expect(focused.tabIndex).toBe(-1);
    expect(isInert(focused)).toBe(false);
    // Masthead comes before the target in DOM order, so a forward Tab from
    // here cannot reach it before the page's own first control.
    expect(masthead.compareDocumentPosition(focused) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not move focus on the first idle render, only after a flip", async () => {
    const before = document.activeElement;
    await renderAt("idle");
    expect(document.activeElement).toBe(before);
  });
});
