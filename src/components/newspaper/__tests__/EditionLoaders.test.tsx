// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Motion reads prefers-reduced-motion once, from matchMedia, when it first
// loads; this file runs with it off (EditionLoadersReducedMotion covers on).
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
import { READING_TIPS_STORAGE_KEY, resetReadingTipsForTests } from "@/components/newspaper/ReadingTips";
import { stubDigestFetch, makeCard, type ScriptedStream } from "./editionTestKit";

// The page around the loaders is stubbed down to what they sit in: TopicNav
// and NewsCard bring in routing and the page-flip context, which these tests
// don't exercise.
vi.mock("@/components/newspaper/TopicNav", () => ({
  TopicNav: ({ pinned }: { pinned?: boolean }) => (
    <nav data-testid="topic-nav" data-pinned={pinned === false ? "false" : "true"} />
  ),
}));
vi.mock("@/components/newspaper/NewsCard", () => ({
  NewsCard: ({ card }: { card: Card }) => <article data-testid="card">{card.title}</article>,
}));

const TOPICS = ["Science", "Football"] as Topic[];

let container: HTMLDivElement;
let root: Root;
let streams: ScriptedStream[];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function digestWith(cards: Card[]): Digest {
  return { id: "d1", date: todayUtc(), lastGeneratedAt: "2026-10-08T07:12:00Z", cards };
}

async function render(props: { initialDigest: Digest | null; firstEdition?: boolean }) {
  await act(async () => {
    root.render(
      <DigestGenerationProvider>
        <FrontPage
          initialDigest={props.initialDigest}
          userTopics={TOPICS}
          timeZone="UTC"
          firstEdition={props.firstEdition}
        />
      </DigestGenerationProvider>
    );
  });
}

/**
 * Advances fake timers in small steps, each in its own act(): React applies a
 * state update (and the typewriter schedules its next character) only when
 * an act() scope ends, so one long advance would type a single character.
 */
async function advance(ms: number) {
  for (let elapsed = 0; elapsed <= ms; elapsed += 10) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }
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
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

beforeEach(() => {
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

describe("empty day (B, typesetting)", () => {
  it("centres a real 'Give me today's news' button with a kicker and a sub-line", async () => {
    await render({ initialDigest: null });
    const button = buttonNamed("Give me today's news");
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.disabled).toBe(false);
    expect(container.textContent).toContain("No edition yet today.");
    expect(container.textContent).toContain("Usually about a minute.");
    expect(q('[data-testid="edition-strip"]')).toBeNull();
    // Said once, by the empty-day block, not repeated by the empty grid.
    expect(container.textContent?.match(/No edition yet today\./g)).toHaveLength(1);
  });

  it("types the reader's topic names before titles arrive, then the run's real titles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render({ initialDigest: null });
    await act(async () => buttonNamed("Give me today's news")!.click());
    await advance(0);

    expect(q('[data-testid="typesetting-loader"]')).not.toBeNull();
    // Typed one character at a time.
    await advance(38 * 3);
    expect(q('[data-testid="typeset-line"]')?.textContent).toBe("Sci");
    await advance(38 * 10);
    expect(q('[data-testid="typeset-line"]')?.textContent).toBe("Science");

    streams[0].send({ stage: "clustering", articleCount: 2, sampleTitles: ["Rates rise", "Cup final"] });
    await advance(0);
    await advance(38 * 20);
    expect(q('[data-testid="typeset-line"]')?.textContent).toBe("Rates rise");
  });

  it("lights the rail by stage and puts the stage sentence in the only live region", async () => {
    await render({ initialDigest: null });
    await click(buttonNamed("Give me today's news")!);

    const lit = () => container.querySelectorAll('[data-testid="progress-rail"] [data-lit="true"]').length;
    expect(lit()).toBe(1);
    expect(container.textContent).toContain("Wires");
    expect(container.textContent).toContain("Front page");

    streams[0].send({ stage: "clustering", articleCount: 351, sampleTitles: [] });
    await flush();
    expect(lit()).toBe(2);
    streams[0].send({ stage: "writing", notableCount: 54 });
    await flush();
    expect(lit()).toBe(4);

    const live = container.querySelectorAll('[role="status"], [aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe("Writing 54 cards…");
    expect(q('[data-testid="typeset-line"]')?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("mounts the live region empty before any run, so its first sentence is announced", async () => {
    await render({ initialDigest: null });
    const status = q('[data-testid="edition-status"]');
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("");

    await click(buttonNamed("Give me today's news")!);
    // Same element, now filled.
    expect(q('[data-testid="edition-status"]')).toBe(status);
    expect(status?.textContent).toBe("Gathering articles…");
  });

  it("types an emoji whole, never half of a surrogate pair", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render({ initialDigest: null });
    await act(async () => buttonNamed("Give me today's news")!.click());
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["🚀 Launch"] });
    await advance(0);
    await advance(38);
    expect(q('[data-testid="typeset-line"]')?.textContent).toBe("🚀");
  });

  it("keeps the button mounted and disabled while a run is in flight", async () => {
    await render({ initialDigest: null });
    await click(buttonNamed("Give me today's news")!);
    const button = buttonNamed("Give me today's news");
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
  });

  it("renders a fetched title containing markup as text, never as HTML", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render({ initialDigest: null });
    await act(async () => buttonNamed("Give me today's news")!.click());
    const evil = '<img src=x onerror="window.__pwned=1">';
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: [evil] });
    await advance(0);
    await advance(38 * (evil.length + 2));
    expect(q('[data-testid="typeset-line"]')?.textContent).toBe(evil);
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows the error and the button again when the run fails", async () => {
    await render({ initialDigest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "error", message: "You've reached your limit of digest runs for now." });
    streams[0].close();
    await flush();
    expect(q('[data-testid="typesetting-loader"]')).toBeNull();
    expect(buttonNamed("Give me today's news")?.disabled).toBe(false);
    expect(container.textContent).toContain("You've reached your limit of digest runs for now.");
  });
});

describe("first-edition notice (D1)", () => {
  it("shows on an empty day for a reader who has never had an edition", async () => {
    await render({ initialDigest: null, firstEdition: true });
    const notice = q('[data-testid="first-edition-notice"]');
    expect(notice?.textContent).toContain("Notice to readers");
    expect(notice?.textContent).toContain("about a minute");
    expect(notice?.textContent).toContain("4 times in any 24 hours");
    expect(notice?.textContent).not.toMatch(/keep this tab open/i);
  });

  it("goes once a run finishes, even one that produced no cards", async () => {
    await render({ initialDigest: null, firstEdition: true });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    expect(buttonNamed("Give me today's news")?.disabled).toBe(false);
    expect(q('[data-testid="first-edition-notice"]')).toBeNull();
  });

  it("stays after a run that failed, since no edition was made", async () => {
    await render({ initialDigest: null, firstEdition: true });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "error", message: "boom" });
    streams[0].close();
    await flush();
    expect(q('[data-testid="first-edition-notice"]')).not.toBeNull();
  });

  it("is absent for a returning reader and on a day with cards", async () => {
    await render({ initialDigest: null, firstEdition: false });
    expect(q('[data-testid="first-edition-notice"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ initialDigest: digestWith([makeCard("c1", { frontPageRank: 1 })]), firstEdition: true });
    expect(q('[data-testid="first-edition-notice"]')).toBeNull();
  });
});

describe("completing day (D, wire ticker strip)", () => {
  const cards = [
    makeCard("c1", { frontPageRank: 1, generatedAt: "2026-10-08T06:00:00Z" }),
    makeCard("c2", { frontPageRank: 2, generatedAt: "2026-10-08T07:12:00Z" }),
    makeCard("c3", { generatedAt: "2026-10-08T07:12:00Z" }),
  ];

  it("pins a slim strip under the topic bar showing the story count and last update", async () => {
    await render({ initialDigest: digestWith(cards) });
    const band = q('[data-testid="front-sticky-band"]');
    const strip = q('[data-testid="edition-strip"]');
    expect(band?.className).toContain("sticky");
    expect(band?.firstElementChild?.getAttribute("data-testid")).toBe("topic-nav");
    expect(band?.firstElementChild?.getAttribute("data-pinned")).toBe("false");
    expect(strip?.parentElement).toBe(band);
    expect(strip?.className).toContain("h-11");
    expect(strip?.textContent).toContain("3 stories · updated 07:12");
    expect(buttonNamed("Complete today's news")?.disabled).toBe(false);
    expect(buttonNamed("Give me today's news")).toBeUndefined();
  });

  it("turns into a ticker of the real titles with the stage in its own area", async () => {
    await render({ initialDigest: digestWith(cards) });
    await click(buttonNamed("Complete today's news")!);

    expect(buttonNamed("Complete today's news")?.disabled).toBe(true);
    const tape = () => q('[data-testid="wire-tape-window"]');
    // Topic names until the titles arrive.
    expect(tape()?.textContent).toContain("Science");
    expect(tape()?.textContent).toContain("Football");

    streams[0].send({ stage: "clustering", articleCount: 9, sampleTitles: ["Rates rise", "<b>Cup</b> final"] });
    await flush();
    expect(tape()?.textContent).toContain("Rates rise");
    expect(tape()?.textContent).toContain("<b>Cup</b> final");
    expect(tape()?.querySelector("b")).toBeNull();
    expect(tape()?.textContent).not.toContain("Football");
    expect(tape()?.getAttribute("aria-hidden")).toBe("true");

    const stage = q('[data-testid="wire-stage"]');
    expect(stage?.getAttribute("aria-hidden")).toBe("true");
    expect(stage?.textContent).toBe("Grouping 9 articles into stories…");
    expect(q('[data-testid="edition-status"]')?.textContent).toBe("Grouping 9 articles into stories…");
    // The tape's window and the stage's area are siblings: the tape can't run under it.
    expect(tape()?.contains(stage)).toBe(false);
    expect(container.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(1);

    const progress = () => q<HTMLElement>('[data-testid="wire-progress"]')!.style.width;
    expect(progress()).toBe("40%");
    streams[0].send({ stage: "ranking" });
    await flush();
    expect(progress()).toBe("100%");
  });

  it("goes back to idle with the new count when the run lands", async () => {
    await render({ initialDigest: digestWith(cards) });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({
      stage: "done",
      cards: [makeCard("c4", { generatedAt: "2026-10-08T09:30:00Z" })],
      rankUpdates: [],
    });
    streams[0].close();
    await flush();
    expect(q('[data-testid="wire-ticker"]')).toBeNull();
    expect(q('[data-testid="edition-strip"]')?.textContent).toContain("4 stories · updated 09:30");
  });

  it("keeps an error visible", async () => {
    await render({ initialDigest: digestWith(cards) });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({ stage: "error", message: "Generating is paused right now. Try again later." });
    streams[0].close();
    await flush();
    expect(container.textContent).toContain("Generating is paused right now. Try again later.");
    expect(buttonNamed("Complete today's news")?.disabled).toBe(false);
  });

  it("switches from B to the strip when an empty day's first run lands", async () => {
    await render({ initialDigest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "done", cards: [makeCard("c1", { frontPageRank: 1 })], rankUpdates: [] });
    streams[0].close();
    await flush();
    expect(q('[data-testid="empty-day-edition"]')).toBeNull();
    expect(q('[data-testid="edition-strip"]')?.textContent).toContain("1 story · updated 07:12");
  });
});

describe("reading tips (D4)", () => {
  const withCards = () => digestWith([makeCard("c1", { frontPageRank: 1 })]);

  it("shows once cards are on the page, and not on an empty day", async () => {
    await render({ initialDigest: null });
    expect(q('[data-testid="reading-tips"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ initialDigest: withCards() });
    const tips = q('[data-testid="reading-tips"]');
    expect(tips?.textContent).toContain("Click a card to read it in full");
    expect(tips?.textContent).toContain("Sources flips it to show the original articles");
    expect(tips?.textContent).toContain("Save keeps it");
    expect(tips?.textContent).toContain("Your topics are the tabs above");
  });

  it("stays dismissed across a reload, via localStorage", async () => {
    await render({ initialDigest: withCards() });
    await click(container.querySelector('[aria-label="Dismiss reading tips"]')!);
    expect(q('[data-testid="reading-tips"]')).toBeNull();
    expect(window.localStorage.getItem(READING_TIPS_STORAGE_KEY)).toBe("1");

    // A reload: fresh module memory, same storage.
    resetReadingTipsForTests();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ initialDigest: withCards() });
    expect(q('[data-testid="reading-tips"]')).toBeNull();
  });

  it("renders the page, and still dismisses, when storage throws", async () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    vi.spyOn(window, "localStorage", "get").mockReturnValue(throwing as unknown as Storage);

    await render({ initialDigest: withCards() });
    expect(q('[data-testid="card"]')).not.toBeNull();
    expect(q('[data-testid="reading-tips"]')).not.toBeNull();
    await click(container.querySelector('[aria-label="Dismiss reading tips"]')!);
    expect(q('[data-testid="reading-tips"]')).toBeNull();
  });
});
