// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Topic } from "@/types";
import { TypesettingLoader } from "@/components/newspaper/TypesettingLoader";
import { WireTicker } from "@/components/newspaper/WireTicker";
import { TopicNav } from "@/components/newspaper/TopicNav";

// The typewriter types whole code points; the wire tape restarts exactly when
// its list's content changes; TopicNav is sticky unless told a parent is.

vi.mock("@/components/newspaper/PageTransitionContext", () => ({
  usePageTransitionActions: () => ({ navigate: vi.fn() }),
}));

const CHAR_MS = 38;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function step(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderLoader(titles: string[], reducedMotion = false) {
  await act(async () =>
    root.render(
      <TypesettingLoader stageEvent={{ stage: "clustering" }} titles={titles} topicNames={[]} reducedMotion={reducedMotion} />
    )
  );
}
const line = () => container.querySelector('[data-testid="typeset-line"]')!.textContent ?? "";

/** Every frame the typewriter shows while typing `title` through once. */
async function framesOf(title: string): Promise<string[]> {
  await renderLoader([title]);
  const frames = [line()];
  for (let i = 0; i < Array.from(title).length; i++) {
    await step(CHAR_MS);
    frames.push(line());
  }
  return frames;
}

describe("typewriter by code point", () => {
  const titles = [
    "🚀 Launch",
    "a😀b😀c",
    "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 math letters",
    "Morocco 🇲🇦 wins",
    "Family 👨‍👩‍👧 day",
    "😀",
    "plain ASCII",
  ];

  for (const title of titles) {
    it(`never shows a lone surrogate and ends on the exact title: ${JSON.stringify(title)}`, async () => {
      const frames = await framesOf(title);
      for (const frame of frames) {
        expect(LONE_SURROGATE.test(frame), `frame ${JSON.stringify(frame)}`).toBe(false);
        expect(title.startsWith(frame)).toBe(true);
      }
      // One frame per code point: each step adds exactly one.
      const lengths = frames.map((f) => Array.from(f).length);
      expect(lengths).toEqual(lengths.map((_, i) => i));
      expect(frames.at(-1)).toBe(title);
    });
  }

  it("a line of only astral characters is typed in as many steps as it has code points, then held", async () => {
    await renderLoader(["😀😀😀", "next"]);
    for (let i = 0; i < 3; i++) await step(CHAR_MS);
    expect(line()).toBe("😀😀😀");
    // Held, not still typing into a phantom 4th-6th "character".
    for (let i = 0; i < 25; i++) await step(40);
    expect(line()).toBe("😀😀😀");
  });

  it("reduced motion shows an astral title whole", async () => {
    await renderLoader(["🚀 Launch"], true);
    expect(line()).toBe("🚀 Launch");
  });
});

describe("wire tape key", () => {
  async function renderTicker(titles: string[]) {
    await act(async () =>
      root.render(<WireTicker stageEvent={{ stage: "clustering" }} titles={titles} topicNames={["Science"]} reducedMotion={false} />)
    );
  }
  const tape = () => container.querySelector('[data-testid="wire-tape-window"]')!.firstElementChild;

  it("restarts the tape for lists a NUL join would merge", async () => {
    await renderTicker(["X\u0000Y"]);
    const first = tape();
    await renderTicker(["X", "Y"]);
    expect(tape()).not.toBe(first);
  });

  it("restarts when the titles replace the topic names", async () => {
    await renderTicker([]);
    const first = tape();
    expect(first?.textContent).toContain("Science");
    await renderTicker(["Rates rise"]);
    expect(tape()).not.toBe(first);
  });

  it("keeps the same tape node for a fresh array with the same titles", async () => {
    await renderTicker(["a", "b"]);
    const first = tape();
    await renderTicker(["a", "b"]);
    expect(tape()).toBe(first);
  });
});

describe("TopicNav pinned", () => {
  const TOPICS = ["Science", "Football"] as Topic[];
  async function renderNav(props: { pinned?: boolean; activeTopic?: Topic }) {
    await act(async () => root.render(<TopicNav topics={TOPICS} {...props} />));
  }
  const nav = () => container.querySelector("nav")!;

  it("is sticky under the masthead by default, as the topic pages use it", async () => {
    await renderNav({ activeTopic: "Science" as Topic });
    expect(nav().className.split(/\s+/)).toContain("sticky");
    expect(nav().style.top).toBe("var(--masthead-height)");
  });

  it("is not sticky, and sets no top offset, when pinned={false}", async () => {
    await renderNav({ pinned: false });
    expect(nav().className.split(/\s+/)).not.toContain("sticky");
    expect(nav().style.top).toBe("");
    // Still opaque, so content never shows through inside the band.
    expect(nav().style.background).toBe("var(--color-background)");
  });
});
