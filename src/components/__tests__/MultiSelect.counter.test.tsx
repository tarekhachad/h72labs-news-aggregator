// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS, type Topic } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";
import { MAX_READING_UNITS, MIN_READING_UNITS } from "@/lib/readingUnits";
import { PreferencesForm } from "@/components/PreferencesForm";
import { MultiSelect } from "@/components/ui/multi-select";

// Below the minimum the shared counter says how many more reading units are
// needed; from the minimum up it reads "n of 10". Countries count as units.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);
const counter = () => document.getElementById("preferences-topics-count")!.textContent;

async function renderPicks(topics: number, countries: number) {
  const savedTopics: Topic[] = plain.slice(0, topics);
  if (countries > 0) savedTopics.push(COUNTRIES_TOPIC);
  await act(async () => {
    root.render(
      <PreferencesForm
        action={async () => {}}
        defaultTopics={savedTopics}
        defaultCountries={COUNTRIES.slice(0, countries)}
        submitLabel="Save"
      />
    );
  });
}

const expected: Record<number, string> = {
  0: "Pick at least 3",
  1: "Pick at least 2 more",
  2: "Pick at least one more",
  3: `3 of ${MAX_READING_UNITS}`,
  10: `10 of ${MAX_READING_UNITS}`,
};

describe("the topics counter", () => {
  it("uses the reading-unit limits it is written against", () => {
    expect([MIN_READING_UNITS, MAX_READING_UNITS]).toEqual([3, 10]);
  });

  it.each([0, 1, 2, 3, 10])("topics only, %i picked", async (n) => {
    await renderPicks(n, 0);
    expect(counter()).toBe(expected[n]);
  });

  it.each([
    [1, 0],
    [2, 1],
    [2, 0],
    [3, 1],
    [3, 2],
    [10, 7],
    [10, 10],
  ])("%i units with %i countries", async (units, countries) => {
    await renderPicks(units - countries, countries);
    expect(counter()).toBe(expected[units]);
  });

  it("keeps the over-limit count and notice above the maximum", async () => {
    await renderPicks(9, 3);
    expect(counter()).toBe(`12 of ${MAX_READING_UNITS}`);
    expect(container.querySelector('p[role="status"]')!.textContent).toContain("Remove 2 before you next save");
  });

  it("takes its numbers from min, not from fixed text", async () => {
    await act(async () => {
      root.render(
        <MultiSelect
          id="t"
          name="t"
          label="T"
          hint="h"
          items={["a", "b", "c", "d", "e", "f"]}
          defaultValue={["a"]}
          min={5}
          max={6}
          noun="things"
          placeholder="p"
        />
      );
    });
    expect(document.getElementById("t-count")!.textContent).toBe("Pick at least 4 more");
  });

  it("shows a plain count with no minimum", async () => {
    await renderPicks(3, 0);
    expect(document.getElementById("preferences-sources-count")!.textContent).toBe("0 selected");
  });
});
