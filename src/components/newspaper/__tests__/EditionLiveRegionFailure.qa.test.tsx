// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.hoisted(() => {
  globalThis.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia;
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Card, Digest, Topic } from "@/types";
import { DigestGenerationProvider } from "@/components/newspaper/DigestGenerationContext";
import { FrontPage } from "@/components/newspaper/FrontPage";
import { resetReadingTipsForTests } from "@/components/newspaper/ReadingTips";
import { stubDigestFetch, makeCard, type ScriptedStream } from "./editionTestKit";

// Failed runs and the single live region (extra QA round 1). Base: the run's single live region across its lifecycle, on both kinds of day and
// on a history page; the first-edition notice against finished, failed and
// stale runs.

vi.mock("@/components/newspaper/TopicNav", () => ({
  TopicNav: () => <nav data-testid="topic-nav" />,
}));
vi.mock("@/components/newspaper/NewsCard", () => ({
  NewsCard: ({ card }: { card: Card }) => <article data-testid="card">{card.title}</article>,
}));

const TOPICS = ["Science", "Football"] as Topic[];
const DAY1 = new Date("2026-10-08T12:00:00Z");
const DAY2 = new Date("2026-10-09T12:00:00Z");

let container: HTMLDivElement;
let root: Root;
let streams: ScriptedStream[];

function digestFor(date: string, cards: Card[]): Digest {
  return { id: `d-${date}`, date, lastGeneratedAt: "2026-10-08T07:12:00Z", cards };
}

type Page =
  | { digest: Digest | null; firstEdition?: boolean; interactive?: boolean; basePath?: string }
  | "elsewhere";

/** The provider stays mounted; `page` swaps what sits under it, like a route change. */
async function show(page: Page) {
  await act(async () => {
    root.render(
      <DigestGenerationProvider>
        {page === "elsewhere" ? (
          <p data-testid="elsewhere">another page</p>
        ) : (
          <FrontPage
            initialDigest={page.digest}
            userTopics={TOPICS}
            timeZone="UTC"
            firstEdition={page.firstEdition}
            interactive={page.interactive}
            basePath={page.basePath}
          />
        )}
      </DigestGenerationProvider>
    );
  });
  await flush();
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return container.querySelector<T>(selector);
}
function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === name);
}
async function click(el: Element) {
  await act(async () => (el as HTMLElement).click());
  await flush();
}

/** Every element a screen reader would treat as a live region. */
function liveRegions(): Element[] {
  return [
    ...container.querySelectorAll('[role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], [aria-live]'),
  ];
}
const status = () => q('[data-testid="edition-status"]');

/** One live region, the edition-status one, holding exactly `text`. */
function expectOneRegion(text: string) {
  const regions = liveRegions();
  expect(regions).toHaveLength(1);
  expect(regions[0].getAttribute("data-testid")).toBe("edition-status");
  expect(regions[0].getAttribute("role")).toBe("status");
  expect(regions[0].getAttribute("aria-live")).toBe("polite");
  expect(regions[0].textContent).toBe(text);
  // Visible copies of the sentence are hidden from assistive tech, so the
  // sentence is read once, not twice.
  for (const id of ["typeset-stage", "wire-stage"]) {
    const visual = q(`[data-testid="${id}"]`);
    if (visual) expect(visual.closest('[aria-hidden="true"]')).not.toBeNull();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DAY1);
  ({ streams } = stubDigestFetch());
  resetReadingTipsForTests();
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


const CARD = () => makeCard("c1", { frontPageRank: 1 });
/** Visible error paragraph on a day with cards: the destructive-coloured <p>. */
function visibleErrorEls(text: string): Element[] {
  return [...container.querySelectorAll("p, div, span")].filter(
    (e) => e.getAttribute("data-testid") !== "edition-status" && e.children.length === 0 && e.textContent === text
  );
}

describe("failed runs and the live region", () => {
  it("day with cards: visible error equals region text, visible copy has no live semantics", async () => {
    await show({ digest: digestFor("2026-10-08", [CARD()]) });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    expectOneRegion("boom");
    const visible = visibleErrorEls("boom");
    expect(visible).toHaveLength(1);
    expect(visible[0].closest("[role],[aria-live]")).toBeNull();
    expect(visible[0].textContent).toBe(status()!.textContent);
  });

  it("empty day: visible error equals region text and EmptyDayEdition adds no live region", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "error", message: "kaput" });
    streams[0].close();
    await flush();
    expectOneRegion("kaput");
    const visible = visibleErrorEls("kaput");
    expect(visible).toHaveLength(1);
    expect(visible[0].closest("[role],[aria-live]")).toBeNull();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("dropped connection on an empty day", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].close();
    await flush();
    expectOneRegion("Connection to the server was lost before the digest finished.");
    expect(visibleErrorEls("Connection to the server was lost before the digest finished.")).toHaveLength(1);
  });

  it("retry clears the error immediately and a second failure shows the new message", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "error", message: "first" });
    streams[0].close();
    await flush();
    expectOneRegion("first");
    await click(buttonNamed("Give me today's news")!);
    expect(container.textContent).not.toContain("first");
    streams[1].send({ stage: "error", message: "second" });
    streams[1].close();
    await flush();
    expectOneRegion("second");
  });

  it("navigate away after a failure and back: still exactly one region, holding the error", async () => {
    await show({ digest: digestFor("2026-10-08", [CARD()]) });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    await show("elsewhere");
    expect(liveRegions()).toHaveLength(0);
    await show({ digest: digestFor("2026-10-08", [CARD()]) });
    expectOneRegion("boom");
    expect(visibleErrorEls("boom")).toHaveLength(1);
  });

  it("failure while away, then back: region holds the error (empty day)", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    await show("elsewhere");
    streams[0].send({ stage: "error", message: "while away" });
    streams[0].close();
    await flush();
    await show({ digest: null });
    expectOneRegion("while away");
  });

  it("a stale run failing after the day rolled over never reaches the new day's region", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    await show("elsewhere");
    vi.setSystemTime(DAY2);
    await show({ digest: null });
    expectOneRegion("");
    streams[0].send({ stage: "error", message: "yesterday's failure" });
    streams[0].close();
    await flush();
    expectOneRegion("");
    expect(container.textContent).not.toContain("yesterday's failure");
  });

  it("an error from one day is cleared by the date re-seed", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    expectOneRegion("boom");
    await show("elsewhere");
    vi.setSystemTime(DAY2);
    await show({ digest: null });
    expectOneRegion("");
  });

  it("history page after a failed run: no region and no error text", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    await show({ digest: digestFor("2026-10-01", [CARD()]), interactive: false, basePath: "/history/2026-10-01" });
    expect(liveRegions()).toHaveLength(0);
    expect(container.textContent).not.toContain("boom");
  });

  it("success after failure empties the region and removes the visible error", async () => {
    await show({ digest: digestFor("2026-10-08", [CARD()]) });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    await click(buttonNamed("Complete today's news")!);
    streams[1].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[1].close();
    await flush();
    expectOneRegion("");
    expect(container.textContent).not.toContain("boom");
  });
});
