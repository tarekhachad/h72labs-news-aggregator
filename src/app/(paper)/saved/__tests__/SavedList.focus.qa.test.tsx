// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SavedCard } from "@/lib/bookmarks";
import type { Topic } from "@/types";
import { SavedList } from "@/app/(paper)/saved/SavedList";

// QA round 1: focus after a confirmed removal on /saved, in the cases the
// lane's own focus test leaves out: an active topic filter (the index is the
// shown list's, not the full list's), the filter's topic vanishing with its
// last card, a heading that already has a tabindex, no <main> around the
// list, and no focus stolen on mount or on a later filter change.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let main: HTMLElement;
let heading: HTMLHeadingElement;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
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

// Full order: a(Tech) b(Football) c(Tech) d(Football) e(Tech)
const CARDS = [
  saved("a", "Tech/AI", "2026-10-12"),
  saved("b", "Football", "2026-10-11"),
  saved("c", "Tech/AI", "2026-10-10"),
  saved("d", "Football", "2026-10-09"),
  saved("e", "Tech/AI", "2026-10-08"),
];

const button = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector('[role="dialog"]');
const cardRoot = (id: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]')].find((el) =>
    el.textContent?.includes(`Title ${id}`)
  );
const topicChip = (name: string) =>
  [...container.querySelectorAll('nav[aria-label="Filter by topic"] button')].find(
    (b) => b.textContent?.trim() === name
  ) as HTMLButtonElement | undefined;

async function render(cards: SavedCard[] = CARDS) {
  await act(async () => root.render(<SavedList initialCards={cards} />));
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => el.click());
}

async function remove(id: string) {
  await click(button("★ Saved", cardRoot(id)!));
  await click(button("Remove", dialog()!));
}

describe("QA: focus after removal under a topic filter", () => {
  it("uses the shown list's position: removing the last shown Tech card goes to the previous shown Tech card", async () => {
    await render();
    await click(topicChip("Tech/AI"));
    // Shown: a, c, e. e is shown-index 2 but full-index 4.
    await remove("e");
    expect(document.activeElement).toBe(cardRoot("c"));
  });

  it("removing the first shown Tech card goes to the next shown Tech card, skipping hidden Football ones", async () => {
    await render();
    await click(topicChip("Tech/AI"));
    await remove("a");
    expect(document.activeElement).toBe(cardRoot("c"));
  });

  it("removing a middle Football card under the Football filter goes to the next Football card", async () => {
    await render([...CARDS, saved("f", "Football", "2026-10-07")]);
    await click(topicChip("Football"));
    // Shown: b, d, f
    await remove("d");
    expect(document.activeElement).toBe(cardRoot("f"));
  });

  it("when the filter's topic loses its last card, the list falls back to All and focus lands on a card, not <body>", async () => {
    await render([saved("a", "Tech/AI", "2026-10-12"), saved("b", "Football", "2026-10-11"), saved("c", "Tech/AI", "2026-10-10")]);
    await click(topicChip("Football"));
    await remove("b");
    // Topic gone: the shown list is now All (a, c); shown-index 0 is a.
    expect(topicChip("Football")).toBeUndefined();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(cardRoot("a"));
  });
});

describe("QA: the heading fallback", () => {
  it("keeps a tabindex the heading already had", async () => {
    heading.setAttribute("tabindex", "0");
    await render([CARDS[0]]);
    await remove("a");
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("0");
  });

  it("with no <main> around the list, removing the only card does not throw and leaves focus on <body>", async () => {
    // Move the container out of <main>.
    document.body.appendChild(container);
    main.remove();
    await render([CARDS[0]]);
    await remove("a");
    expect(container.textContent).toContain("Nothing saved yet.");
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses the h1 inside <main>, not an h1 elsewhere on the page", async () => {
    const outer = document.createElement("h1");
    outer.textContent = "Masthead";
    document.body.prepend(outer);
    await render([CARDS[0]]);
    await remove("a");
    expect(document.activeElement).toBe(heading);
    expect(outer.hasAttribute("tabindex")).toBe(false);
  });
});

describe("QA: focus is only moved by a removal", () => {
  it("does not take focus on first render", async () => {
    await render();
    expect(document.activeElement).toBe(document.body);
    expect(heading.hasAttribute("tabindex")).toBe(false);
  });

  it("does not take focus back on a filter change after a removal", async () => {
    await render();
    await remove("a");
    expect(document.activeElement).toBe(cardRoot("b"));
    // jsdom's click() does not move focus, so put it on a chip by hand first.
    const all = topicChip("All")!;
    all.focus();
    await click(topicChip("Football"));
    // Focus stays on the chip, not yanked back to a card by the effect.
    expect(document.activeElement).toBe(all);
  });

  it("does not move focus when a card's removal fails", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await render();
    await remove("b");
    expect(cardRoot("b")).toBeDefined();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it("focuses a real card root (role=button, tabindex 0), never a grid placeholder", async () => {
    await render();
    await remove("c");
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute("role")).toBe("button");
    expect(active.tabIndex).toBe(0);
    expect(active.textContent).toContain("Title d");
  });
});
