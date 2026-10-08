// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { MAX_TOPICS } from "@/lib/profile";
import { PreferencesForm } from "@/components/PreferencesForm";

// Enter, autoHighlight and the submit guard in the preferences pickers.
// jsdom performs no implicit form submission, so "would a browser submit?"
// is asserted as the keydown's defaultPrevented. Names are TOPICS/SOURCES by
// position or computed from them.

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

async function renderForm(defaults: { topics?: Topic[]; sources?: Source[] } = {}) {
  await act(async () => {
    root.render(
      <PreferencesForm
        action={async () => {}}
        defaultTopics={defaults.topics}
        defaultSources={defaults.sources}
        submitLabel="Save"
      />
    );
  });
}

const topicsInput = () => document.getElementById("preferences-topics") as HTMLInputElement;
const sourcesInput = () => document.getElementById("preferences-sources") as HTMLInputElement;
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

/** Dispatches a keydown; returns whether something prevented its default. */
async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await flush();
  return event.defaultPrevented;
}

async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: text === "" ? "deleteContentBackward" : "insertText",
        data: text,
      })
    );
  });
  await flush();
}

const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const optionLabels = () => options().map((o) => o.textContent);
const highlighted = () => options().filter((o) => o.hasAttribute("data-highlighted")).map((o) => o.textContent);
const activeLabel = (input: HTMLInputElement) => {
  const id = input.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent ?? null : null;
};
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

// A topic whose name is contained in at least one other topic's name, so
// searching for it yields several matches with a known order.
function multiMatchQuery() {
  const query = TOPICS.find((a) => TOPICS.some((b) => b !== a && b.includes(a)));
  expect(query, "catalog needs a topic contained in another for these cases").toBeDefined();
  const matches = TOPICS.filter((t) => t.toLowerCase().includes(query!.toLowerCase()));
  expect(matches.length).toBeGreaterThan(1);
  return { query: query!, matches };
}

describe("autoHighlight", () => {
  it("highlights the first filtered match as soon as the reader types", async () => {
    const { query, matches } = multiMatchQuery();
    await renderForm({ topics: TOPICS.filter((t) => !matches.includes(t)).slice(0, 3) });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, query);

    expect(optionLabels()).toEqual(matches);
    expect(highlighted()).toEqual([matches[0]]);
    expect(activeLabel(input)).toBe(matches[0]);
  });

  it("ArrowDown after typing moves to the second match, and Enter picks that one", async () => {
    const { query, matches } = multiMatchQuery();
    const start = TOPICS.filter((t) => !matches.includes(t)).slice(0, 3);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, query);
    await key(input, "ArrowDown");
    expect(activeLabel(input)).toBe(matches[1]);

    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual([...start, matches[1]]);
  });

  it("an Enter pick clears the search and closes the list; a second Enter is left to submit", async () => {
    const start = TOPICS.slice(0, 3);
    const target = TOPICS[TOPICS.length - 1];
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, target);

    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual([...start, target]);
    expect(input.value).toBe("");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    expect(await key(input, "Enter")).toBe(false);
    expect(fieldValues("topics")).toEqual([...start, target]);
  });

  it("an empty box opened with ArrowDown highlights the last pick, not the first item", async () => {
    const start = TOPICS.slice(2, 5);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await key(input, "ArrowDown");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(activeLabel(input)).toBe(start.at(-1));
  });
});

describe("Enter can never pick a disabled item", () => {
  it("at the limit, a disabled first match is highlighted but Enter neither picks it nor touches a later match", async () => {
    const { query, matches } = multiMatchQuery();
    const others = TOPICS.filter((t) => !matches.includes(t));
    const picked = [...matches.slice(1), ...others].slice(0, MAX_TOPICS) as Topic[];
    expect(picked).toHaveLength(MAX_TOPICS);
    await renderForm({ topics: picked });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, query);

    const first = options()[0]!;
    expect(first.textContent).toBe(matches[0]);
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(activeLabel(input)).toBe(matches[0]);

    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(picked);
    // Repeated presses stay inert.
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(picked);
  });

  it("over the limit, Enter on an unpicked match does nothing and the trim notice stays", async () => {
    const saved = TOPICS.slice(0, MAX_TOPICS + 1);
    const unpicked = TOPICS[MAX_TOPICS + 1];
    await renderForm({ topics: saved });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, unpicked);
    expect(options()[0]!.getAttribute("aria-disabled")).toBe("true");

    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(saved);
    expect(
      [...container.querySelectorAll('p[role="status"]')].some((p) => p.textContent?.includes("limit is now"))
    ).toBe(true);
  });
});

describe("search text that isn't a real query", () => {
  it("a whitespace-only search keeps the list closed and Enter neither picks nor submits", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, "   ");

    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(start);
  });

  it("Shift+Enter with text in the box doesn't submit", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, "zzqx");
    expect(await key(input, "Enter", { shiftKey: true })).toBe(true);
  });
});

describe("IME composition", () => {
  it("Enter that commits a composition picks nothing; Enter after compositionend picks the first match", async () => {
    const start = TOPICS.slice(0, 3);
    const target = TOPICS[TOPICS.length - 1];
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    await type(input, target);

    // The composing Enter (keyCode 229) must not toggle whatever is highlighted.
    expect(
      await key(input, "Enter", { isComposing: true, keyCode: 229, which: 229 } as KeyboardEventInit)
    ).toBe(true);
    expect(fieldValues("topics")).toEqual(start);

    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: target }));
    });
    await flush();
    expect(activeLabel(input)).toBe(target);
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual([...start, target]);
  });
});

describe("sources picker", () => {
  it("type then Enter picks the first match without submitting; sources have no limit", async () => {
    const target = SOURCES[SOURCES.length - 1];
    await renderForm({ topics: TOPICS.slice(0, 3), sources: SOURCES.slice(0, MAX_TOPICS) });
    const input = sourcesInput();
    await act(async () => input.focus());
    await type(input, target);
    expect(options()[0]!.getAttribute("aria-disabled")).toBeNull();

    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("preferredSources")).toEqual([...SOURCES.slice(0, MAX_TOPICS), target]);
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, 3));
  });

  it("Enter in an empty, closed sources box is left to submit", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = sourcesInput();
    await act(async () => input.focus());
    expect(await key(input, "Enter")).toBe(false);
  });
});

describe("chip keyboard after an Enter pick", () => {
  it("ArrowLeft reaches the new chip and Backspace on the empty box removes it", async () => {
    const start = TOPICS.slice(0, 3);
    const target = TOPICS[TOPICS.length - 1];
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, target);
    await key(input, "Enter");
    expect(fieldValues("topics")).toEqual([...start, target]);

    await key(input, "ArrowLeft");
    const chip = document.activeElement as HTMLElement;
    expect(chip.getAttribute("data-slot")).toBe("combobox-chip");
    expect(chip.textContent).toBe(target);
    await key(chip, "ArrowRight");
    expect(document.activeElement).toBe(input);

    await key(input, "Backspace");
    expect(fieldValues("topics")).toEqual(start);
  });

  it("Escape with a search open closes the list and clears the text, keeping every pick", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, TOPICS[TOPICS.length - 1]);
    await key(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("");
    expect(fieldValues("topics")).toEqual(start);
  });
});
