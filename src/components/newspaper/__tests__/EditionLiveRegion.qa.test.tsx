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

// The run's single live region across its lifecycle, on both kinds of day and
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
const notice = () => q('[data-testid="first-edition-notice"]');

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

describe("the live region across a run", () => {
  it("empty day: empty, then each stage, then empty again; the same element throughout, even as the day gains cards", async () => {
    await show({ digest: null });
    expectOneRegion("");
    const region = status();

    await click(buttonNamed("Give me today's news")!);
    expectOneRegion("Gathering articles…");
    streams[0].send({ stage: "clustering", articleCount: 7, sampleTitles: ["A"] });
    await flush();
    expectOneRegion("Grouping 7 articles into stories…");
    streams[0].send({ stage: "writing", notableCount: 1 });
    await flush();
    expectOneRegion("Writing 1 card…");

    streams[0].send({ stage: "done", cards: [makeCard("c1", { frontPageRank: 1 })], rankUpdates: [] });
    streams[0].close();
    await flush();
    // The empty day became a day with cards; the region is the same node, now empty.
    expect(q('[data-testid="card"]')).not.toBeNull();
    expectOneRegion("");
    expect(status()).toBe(region);
  });

  it("day with cards: the strip's run fills and empties the same single region", async () => {
    await show({ digest: digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]) });
    expectOneRegion("");
    const region = status();
    await click(buttonNamed("Complete today's news")!);
    expectOneRegion("Gathering articles…");
    expect(q('[data-testid="wire-stage"]')?.textContent).toBe("Gathering articles…");
    streams[0].send({ stage: "triaging", clusterCount: 4 });
    await flush();
    expectOneRegion("Checking 4 stories for notability…");
    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    expectOneRegion("");
    expect(status()).toBe(region);
  });

  it("empties on a failed run", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    expect(container.textContent).toContain("boom");
    expectOneRegion("");
  });

  it("empties when the connection drops without a terminal event", async () => {
    await show({ digest: digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]) });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({ stage: "ingesting" });
    streams[0].close();
    await flush();
    expect(container.textContent).toContain("Connection to the server was lost");
    expectOneRegion("");
  });

  it("navigate away mid-run and back: one region with the current stage, then empty when the run ends", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "clustering", articleCount: 3 });
    await flush();
    expectOneRegion("Grouping 3 articles into stories…");

    await show("elsewhere");
    expect(liveRegions()).toHaveLength(0);
    streams[0].send({ stage: "triaging", clusterCount: 2 });
    await flush();

    await show({ digest: null });
    expectOneRegion("Checking 2 stories for notability…");
    streams[0].send({ stage: "ranking" });
    await flush();
    expectOneRegion("Picking today's front page…");
    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    expectOneRegion("");
  });

  it("navigate away and the run ends while away: back to an empty region", async () => {
    await show({ digest: digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]) });
    await click(buttonNamed("Complete today's news")!);
    await show("elsewhere");
    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    await show({ digest: digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]) });
    expectOneRegion("");
  });

  it("a stale run's stages never reach the new day's region", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    await show("elsewhere");
    vi.setSystemTime(DAY2);
    await show({ digest: null });
    expectOneRegion("");
    streams[0].send({ stage: "writing", notableCount: 5 });
    await flush();
    expectOneRegion("");
  });
});

describe("history pages", () => {
  it("a past front page (interactive=false) renders no live region at all", async () => {
    await show({
      digest: digestFor("2026-10-01", [makeCard("c1", { frontPageRank: 1 })]),
      interactive: false,
      basePath: "/history/2026-10-01",
    });
    expect(q('[data-testid="card"]')).not.toBeNull();
    expect(status()).toBeNull();
    expect(liveRegions()).toHaveLength(0);
  });

  it("a past front page stays region-free while today's run is in flight in the provider", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    await show({
      digest: digestFor("2026-10-01", [makeCard("c1", { frontPageRank: 1 })]),
      interactive: false,
      basePath: "/history/2026-10-01",
    });
    streams[0].send({ stage: "clustering", articleCount: 2 });
    await flush();
    expect(liveRegions()).toHaveLength(0);
    expect(container.textContent).not.toContain("Grouping");
  });
});

describe("first-edition notice against finishedRunDate", () => {
  it("stays hidden after a zero-card run when the reader navigates away and back the same day", async () => {
    await show({ digest: null, firstEdition: true });
    expect(notice()).not.toBeNull();
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    expect(notice()).toBeNull();
    await show("elsewhere");
    // The server snapshot may still be the stale "first edition" one.
    await show({ digest: null, firstEdition: true });
    expect(notice()).toBeNull();
  });

  it("a stale run for yesterday that finishes after the date changed does not hide today's notice", async () => {
    await show({ digest: null, firstEdition: true });
    await click(buttonNamed("Give me today's news")!);
    await show("elsewhere");
    vi.setSystemTime(DAY2);
    await show({ digest: null, firstEdition: true });
    expect(notice()).not.toBeNull();

    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    expect(notice()).not.toBeNull();
    expect(buttonNamed("Give me today's news")?.disabled).toBe(false);
  });

  it("a run that finished yesterday does not hide the notice on a new day the server still calls a first edition", async () => {
    await show({ digest: null, firstEdition: true });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    expect(notice()).toBeNull();

    await show("elsewhere");
    vi.setSystemTime(DAY2);
    await show({ digest: null, firstEdition: true });
    expect(notice()).not.toBeNull();
  });

  it("is never shown for a returning reader, finished run or not", async () => {
    await show({ digest: null, firstEdition: false });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    expect(notice()).toBeNull();
  });

  it("a failed retry after a finished zero-card run keeps the notice gone", async () => {
    await show({ digest: null, firstEdition: true });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    await click(buttonNamed("Give me today's news")!);
    streams[1].send({ stage: "error", message: "boom" });
    streams[1].close();
    await flush();
    expect(notice()).toBeNull();
  });
});
