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
import { TypesettingLoader } from "@/components/newspaper/TypesettingLoader";
import { READING_TIPS_STORAGE_KEY, resetReadingTipsForTests } from "@/components/newspaper/ReadingTips";
import { stubDigestFetch, makeCard, type ScriptedStream } from "./editionTestKit";

// The loaders under the provider's stale-run guards, a navigation away and
// back, storage that throws on access, and untrusted title text.

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

/** The provider stays mounted; `page` swaps what sits under it, like a route change. */
async function show(page: { digest: Digest | null } | "elsewhere") {
  await act(async () => {
    root.render(
      <DigestGenerationProvider>
        {page === "elsewhere" ? (
          <p data-testid="elsewhere">another page</p>
        ) : (
          <FrontPage initialDigest={page.digest} userTopics={TOPICS} timeZone="UTC" />
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
const tapeText = () => q('[data-testid="wire-tape-window"]')?.textContent ?? null;

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

describe("titles across navigation (provider survives the route change)", () => {
  it("navigating away mid-run and back resumes the ticker with the run's titles and stage", async () => {
    const day = digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]);
    await show({ digest: day });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({ stage: "clustering", articleCount: 4, sampleTitles: ["Rates rise", "Cup final"] });
    await flush();
    expect(tapeText()).toContain("Rates rise");

    await show("elsewhere");
    expect(q('[data-testid="wire-ticker"]')).toBeNull();
    streams[0].send({ stage: "triaging", clusterCount: 3 });
    await flush();

    // Back on the front page with the same server snapshot.
    await show({ digest: day });
    expect(q('[data-testid="wire-ticker"]')).not.toBeNull();
    expect(tapeText()).toContain("Rates rise");
    expect(tapeText()).toContain("Cup final");
    expect(tapeText()).not.toContain("Football");
    expect(q('[data-testid="wire-stage"]')?.textContent).toBe("Checking 3 stories for notability…");
    expect(buttonNamed("Complete today's news")?.disabled).toBe(true);
  });

  it("empty day: navigating back mid-run resumes the typesetting loader typing the run's titles", async () => {
    await show({ digest: null });
    await click(buttonNamed("Give me today's news")!);
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["Zebra crossing"] });
    await flush();
    await show("elsewhere");
    await show({ digest: null });
    expect(q('[data-testid="typesetting-loader"]')).not.toBeNull();
    // Wait (real timers) long enough for a few characters to be typed.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const typed = q('[data-testid="typeset-line"]')?.textContent ?? "";
    expect(typed.length).toBeGreaterThan(0);
    expect("Zebra crossing".startsWith(typed)).toBe(true);
  });

  it("after the date moves on mid-run, the old run's titles and stages never reach the new day, even while a new run is in flight", async () => {
    await show({ digest: digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]) });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["Yesterday title"] });
    await flush();

    // Leave, the day rolls over, come back to a new day's snapshot.
    await show("elsewhere");
    vi.setSystemTime(DAY2);
    await show({ digest: digestFor("2026-10-09", [makeCard("n1", { frontPageRank: 1 })]) });
    expect(q('[data-testid="wire-ticker"]')).toBeNull();
    expect(buttonNamed("Complete today's news")?.disabled).toBe(false);

    // The old run carries on and sends titles: nothing shows.
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["Stale A"] });
    await flush();
    expect(q('[data-testid="wire-ticker"]')).toBeNull();

    // A new run for the new day starts; the tape shows topic names, not old titles.
    await click(buttonNamed("Complete today's news")!);
    expect(streams).toHaveLength(2);
    expect(tapeText()).toContain("Science");
    expect(tapeText()).not.toContain("Yesterday title");
    expect(tapeText()).not.toContain("Stale A");

    // The old run sends more titles and then ends, mid new run.
    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["Stale B"] });
    streams[0].send({ stage: "writing", notableCount: 99 });
    await flush();
    expect(tapeText()).not.toContain("Stale B");
    expect(q('[data-testid="wire-stage"]')?.textContent).toBe("Gathering articles…");
    streams[0].send({ stage: "error", message: "old run failed" });
    streams[0].close();
    await flush();
    // The old run's end clears nothing of the new run's.
    expect(q('[data-testid="wire-ticker"]')).not.toBeNull();
    expect(container.textContent).not.toContain("old run failed");

    streams[1].send({ stage: "clustering", articleCount: 2, sampleTitles: ["Fresh title"] });
    await flush();
    expect(tapeText()).toContain("Fresh title");
    expect(tapeText()).not.toContain("Stale");

    expect(q('[data-testid="wire-stage"]')?.textContent).toBe("Grouping 2 articles into stories…");
  });
});

describe("untrusted title text", () => {
  const nasty = [
    '<script>window.__pwned=1</script>',
    '<img src=x onerror="window.__pwned=1">',
    "&lt;b&gt;entity&lt;/b&gt;",
    '"><svg onload=alert(1)>',
  ];

  it("renders markup as literal text in the tape, with no elements created", async () => {
    await show({ digest: digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]) });
    await click(buttonNamed("Complete today's news")!);
    streams[0].send({ stage: "clustering", articleCount: 4, sampleTitles: nasty });
    await flush();
    const tape = q('[data-testid="wire-tape-window"]')!;
    for (const t of nasty) expect(tape.textContent).toContain(t);
    expect(tape.querySelector("script, img, svg, b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("renders markup as literal text in the typed line under reduced motion (whole line)", async () => {
    await act(async () =>
      root.render(
        <TypesettingLoader
          stageEvent={{ stage: "clustering" }}
          titles={[nasty[1]]}
          topicNames={TOPICS}
          reducedMotion
        />
      )
    );
    const line = q('[data-testid="typeset-line"]')!;
    expect(line.textContent).toBe(nasty[1]);
    expect(line.querySelector("img")).toBeNull();
  });

  it("a title containing the typewriter's internal separator (U+0000) is still typed as one line", async () => {
    const title = "Before\u0000After";
    await act(async () =>
      root.render(
        <TypesettingLoader stageEvent={{ stage: "clustering" }} titles={[title]} topicNames={TOPICS} reducedMotion />
      )
    );
    expect(q('[data-testid="typeset-line"]')!.textContent).toBe(title);
  });
});

describe("reduced motion off: the typewriter's own timing", () => {
  it("types a line, holds it, then moves on to the next title from its start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await act(async () =>
      root.render(
        <TypesettingLoader
          stageEvent={{ stage: "clustering" }}
          titles={["Ab", "Cd"]}
          topicNames={TOPICS}
          reducedMotion={false}
        />
      )
    );
    const line = () => q('[data-testid="typeset-line"]')!.textContent;
    const step = async (ms: number) => {
      for (let t = 0; t < ms; t += 10) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
      }
    };
    expect(line()).toBe("");
    await step(100);
    expect(line()).toBe("Ab");
    await step(1000);
    expect(line()).toBe("Ab"); // held
    await step(500);
    expect(line()?.startsWith("C") || line() === "").toBe(true);
    await step(200);
    expect(line()).toBe("Cd");
  });
});

describe("reduced motion on: whole lines, no transitions", () => {
  it("shows each title whole and swaps to the next whole title, never a partial one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await act(async () =>
      root.render(
        <TypesettingLoader
          stageEvent={{ stage: "writing", notableCount: 3 }}
          titles={["First whole headline", "Second whole headline"]}
          topicNames={TOPICS}
          reducedMotion
        />
      )
    );
    const line = () => q('[data-testid="typeset-line"]')!.textContent;
    const seen = new Set<string>();
    for (let t = 0; t < 9000; t += 250) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      seen.add(line() ?? "");
    }
    expect([...seen].sort()).toEqual(["First whole headline", "Second whole headline"]);
    // Body rules and caret carry no motion.
    const rules = container.querySelectorAll<HTMLElement>('[data-testid="typesetting-loader"] b');
    expect(rules.length).toBe(14);
    rules.forEach((r) => expect(r.style.transition).toBe(""));
    expect(q(".edition-caret-blink")).toBeNull();
  });
});

describe("reading tips with hostile storage", () => {
  const withCards = () => digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]);

  it("renders the page and dismisses when merely touching window.localStorage throws", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    await show({ digest: withCards() });
    expect(q('[data-testid="card"]')).not.toBeNull();
    expect(q('[data-testid="reading-tips"]')).not.toBeNull();
    await click(container.querySelector('[aria-label="Dismiss reading tips"]')!);
    expect(q('[data-testid="reading-tips"]')).toBeNull();
  });

  it("when only setItem throws, the tips stay dismissed for the page's lifetime across a remount", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await show({ digest: withCards() });
    await click(container.querySelector('[aria-label="Dismiss reading tips"]')!);
    expect(q('[data-testid="reading-tips"]')).toBeNull();
    await show("elsewhere");
    await show({ digest: withCards() });
    expect(q('[data-testid="reading-tips"]')).toBeNull();
  });

  it("another tab's dismissal hides them here via the storage event", async () => {
    await show({ digest: withCards() });
    expect(q('[data-testid="reading-tips"]')).not.toBeNull();
    window.localStorage.setItem(READING_TIPS_STORAGE_KEY, "1");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: READING_TIPS_STORAGE_KEY, newValue: "1" }));
    });
    expect(q('[data-testid="reading-tips"]')).toBeNull();
  });

  it("a stored value other than \"1\" does not count as dismissed", async () => {
    window.localStorage.setItem(READING_TIPS_STORAGE_KEY, "true");
    await show({ digest: withCards() });
    expect(q('[data-testid="reading-tips"]')).not.toBeNull();
  });
});

describe("the strip's hit area and in-flight button", () => {
  it("the strip button is a real button that stays mounted and disabled through the run, then re-enables", async () => {
    await show({ digest: digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1 })]) });
    const before = buttonNamed("Complete today's news")!;
    await click(before);
    const during = buttonNamed("Complete today's news")!;
    expect(during).toBe(before);
    expect(during.disabled).toBe(true);
    // A second press while disabled starts nothing.
    await click(during);
    expect(streams).toHaveLength(1);
    streams[0].send({ stage: "done", cards: [], rankUpdates: [] });
    streams[0].close();
    await flush();
    expect(buttonNamed("Complete today's news")?.disabled).toBe(false);
  });

  it("the strip shows the newest stamp in the reader's zone through FrontPage", async () => {
    await act(async () => {
      root.render(
        <DigestGenerationProvider>
          <FrontPage
            initialDigest={digestFor("2026-10-08", [makeCard("c1", { frontPageRank: 1, generatedAt: "2026-10-08T07:12:00Z" })])}
            userTopics={TOPICS}
            timeZone="America/New_York"
          />
        </DigestGenerationProvider>
      );
    });
    await flush();
    expect(q('[data-testid="edition-strip"]')?.textContent).toContain("1 story · updated 03:12");
  });
});
