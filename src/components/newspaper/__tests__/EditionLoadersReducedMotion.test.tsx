// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Motion reads prefers-reduced-motion once, from matchMedia, when it first
// loads, so this file sets it on before any import of motion.
vi.hoisted(() => {
  globalThis.matchMedia = ((q: string) => ({
    matches: q.includes("prefers-reduced-motion"),
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
import type { Card, Topic } from "@/types";
import { DigestGenerationProvider } from "@/components/newspaper/DigestGenerationContext";
import { FrontPage } from "@/components/newspaper/FrontPage";
import { stubDigestFetch, makeCard, type ScriptedStream } from "./editionTestKit";

vi.mock("@/components/newspaper/TopicNav", () => ({
  TopicNav: () => <nav data-testid="topic-nav" />,
}));
vi.mock("@/components/newspaper/NewsCard", () => ({
  NewsCard: ({ card }: { card: Card }) => <article data-testid="card">{card.title}</article>,
}));

let container: HTMLDivElement;
let root: Root;
let streams: ScriptedStream[];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === name);
}

async function render(cards: Card[] | null) {
  await act(async () => {
    root.render(
      <DigestGenerationProvider>
        <FrontPage
          initialDigest={
            cards
              ? { id: "d1", date: new Date().toISOString().slice(0, 10), lastGeneratedAt: null, cards }
              : null
          }
          userTopics={["Science", "Football"] as Topic[]}
          timeZone="UTC"
        />
      </DigestGenerationProvider>
    );
  });
}

beforeEach(() => {
  ({ streams } = stubDigestFetch());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("edition loaders under reduced motion", () => {
  it("B shows each line whole, with no blinking caret and no rail transitions", async () => {
    await render(null);
    await act(async () => buttonNamed("Give me today's news")!.click());
    await flush();

    const line = container.querySelector('[data-testid="typeset-line"]')!;
    expect(line.textContent).toBe("Science");
    expect(line.querySelector(".edition-caret-blink")).toBeNull();

    streams[0].send({ stage: "clustering", articleCount: 1, sampleTitles: ["A whole headline at once"] });
    await flush();
    expect(container.querySelector('[data-testid="typeset-line"]')!.textContent).toBe("A whole headline at once");

    const segments = container.querySelectorAll<HTMLElement>('[data-testid="progress-rail"] i');
    expect(segments).toHaveLength(5);
    segments.forEach((s) => expect(s.style.transition).toBe(""));
  });

  it("D shows the stage sentence alone, with no scrolling tape and no animated progress", async () => {
    await render([makeCard("c1", { frontPageRank: 1 })]);
    await act(async () => buttonNamed("Complete today's news")!.click());
    await flush();
    streams[0].send({ stage: "clustering", articleCount: 3, sampleTitles: ["One", "Two"] });
    await flush();

    expect(container.querySelector('[data-testid="wire-tape-window"]')).toBeNull();
    expect(container.querySelector(".edition-tape")).toBeNull();
    expect(container.querySelector('[data-testid="wire-stage"]')?.textContent).toBe(
      "Grouping 3 articles into stories…"
    );
    expect(container.querySelector<HTMLElement>('[data-testid="wire-progress"]')!.style.transition).toBe("");
  });
});
