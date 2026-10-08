// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TypesettingLoader } from "@/components/newspaper/TypesettingLoader";

// The typewriter's list identity: it restarts from the first line, first
// character, whenever the list's content changes, never when only the
// array's identity does, and every title round-trips exactly whatever
// characters it carries.

const TOPICS = ["Science", "Football"];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(titles: string[], reducedMotion: boolean, topicNames: string[] = TOPICS) {
  await act(async () =>
    root.render(
      <TypesettingLoader
        stageEvent={{ stage: "clustering" }}
        titles={titles}
        topicNames={topicNames}
        reducedMotion={reducedMotion}
      />
    )
  );
}
const line = () => container.querySelector('[data-testid="typeset-line"]')!.textContent;
async function step(ms: number, by = 10) {
  for (let t = 0; t < ms; t += by) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(by);
    });
  }
}

describe("restart when the list's content changes", () => {
  it("reduced motion: on the second line, a new list shows its first line at once, then its second", async () => {
    await render(["A1", "B1"], true);
    expect(line()).toBe("A1");
    await step(4000, 250);
    expect(line()).toBe("B1");
    await render(["C1", "D1"], true);
    expect(line()).toBe("C1");
    await step(4000, 250);
    expect(line()).toBe("D1");
  });

  it("typing: mid-line, a new list restarts at its first character and types it out", async () => {
    await render(["Alpha", "Beta"], false);
    await step(38 * 3 + 5, 1);
    expect(line()).toBe("Alp");
    await render(["Gamma"], false);
    expect(line()).toBe("");
    await step(38 * 2 + 5, 1);
    expect(line()).toBe("Ga");
    await step(38 * 3 + 5, 1);
    expect(line()).toBe("Gamma");
  });

  it("the reader's topic names give way to the run's titles from the first title", async () => {
    await render([], true);
    expect(line()).toBe("Science");
    await step(4000, 250);
    expect(line()).toBe("Football");
    await render(["T1", "T2"], true);
    expect(line()).toBe("T1");
  });

  it("a list that shrinks under the current line index restarts at line 0, not at index mod length", async () => {
    await render(["L0", "L1", "L2"], true);
    await step(8000, 250);
    expect(line()).toBe("L2");
    await render(["M0", "M1"], true);
    expect(line()).toBe("M0");
  });

  it("lists that a NUL join would merge are distinct: ['X\\0Y'] and ['X','Y']", async () => {
    await render(["X\u0000Y"], true);
    expect(line()).toBe("X\u0000Y");
    await render(["X", "Y"], true);
    expect(line()).toBe("X");
    await step(4000, 250);
    expect(line()).toBe("Y");
    await render(["X\u0000Y"], true);
    expect(line()).toBe("X\u0000Y");
  });

  it("lists that a comma join would merge are distinct: ['a,b'] and ['a','b']", async () => {
    await render(["a,b"], true);
    expect(line()).toBe("a,b");
    await render(["a", "b"], true);
    expect(line()).toBe("a");
  });
});

describe("no restart when only the array's identity changes", () => {
  it("reduced motion: a fresh array with the same titles keeps the current line", async () => {
    await render(["A1", "B1"], true);
    await step(4000, 250);
    expect(line()).toBe("B1");
    await render(["A1", "B1"].slice(), true);
    expect(line()).toBe("B1");
  });

  it("typing: a fresh array with the same titles keeps typing where it was", async () => {
    await render(["Alpha"], false);
    await step(38 * 3 + 5, 1);
    expect(line()).toBe("Alp");
    await render(["Alpha"].slice(), false);
    expect(line()).toBe("Alp");
    await step(38 * 2 + 5, 1);
    expect(line()).toBe("Alpha");
  });
});

describe("titles round-trip exactly", () => {
  const hostile = [
    'He said "hi" \\ and left',
    "[\"not\",\"a\",\"list\"]",
    "null",
    "line separator",
    "emoji 🚀 and lone \ud800 surrogate",
    "",
  ];
  it("every character-hostile title is shown exactly as given, one per line", async () => {
    await render(hostile, true);
    const seen: string[] = [];
    for (let i = 0; i < hostile.length; i++) {
      seen.push(line() ?? "");
      await step(4000, 250);
    }
    expect(seen).toEqual(hostile);
  });

  it("empty titles and empty topic names show nothing and schedule no timer", async () => {
    await render([], false, []);
    expect(line()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
