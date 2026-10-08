// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { MAX_TOPICS, ProfileInput } from "@/lib/profile";
import { PreferencesForm } from "@/components/PreferencesForm";

// The preferences form as a reader uses it: real Base UI Combobox, real DOM
// events, and a real form submission whose FormData is what the onboarding
// and profile actions receive. No names are hard-coded: the catalog is
// growing and being renamed, so every pick is TOPICS/SOURCES by position.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The topics list offers every topic but Countries, which has its own picker.
const PICKABLE_TOPICS = TOPICS.filter((t) => t !== "Countries");

let container: HTMLDivElement;
let root: Root;
let submitted: FormData[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  submitted = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function renderForm(defaults: { topics?: Topic[]; sources?: Source[] } = {}) {
  await act(async () => {
    root.render(
      <PreferencesForm
        action={async (_previous, formData) => {
          submitted.push(formData);
        }}
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
async function key(target: Element, k: string) {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

// An InputEvent with an inputType, as a keyboard produces: Base UI treats an
// input event without one as browser autofill and doesn't open the list.
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

async function open(input: HTMLInputElement) {
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  await flush();
}

/** The open listbox's option labels, in order. */
const optionLabels = () =>
  [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent);

const option = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  );

/** Values the form would submit under `name`, read from the DOM. */
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

const chipLabels = (input: HTMLInputElement) =>
  [...input.closest('[data-slot="combobox-chips"]')!.querySelectorAll('[data-slot="combobox-chip"]')].map(
    (chip) => chip.textContent
  );

const counter = (input: HTMLInputElement) =>
  document.getElementById(`${input.id}-count`)!.textContent;

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  return submitted.at(-1)!;
}

describe("PreferencesForm pickers", () => {
  it("labels each picker and describes its limits", async () => {
    await renderForm();

    for (const [input, label] of [
      [topicsInput(), "Topics"],
      [sourcesInput(), "Preferred sources"],
    ] as const) {
      expect(input.getAttribute("role")).toBe("combobox");
      expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(label);
      const describedBy = input.getAttribute("aria-describedby")!.split(" ");
      expect(describedBy).toEqual([`${input.id}-hint`, `${input.id}-count`]);
    }
    expect(document.getElementById("preferences-topics-hint")!.textContent).toContain(
      `Pick 3 to ${MAX_TOPICS}`
    );
    expect(document.getElementById("preferences-sources-hint")!.textContent).toContain("Optional");
    expect(counter(topicsInput())).toBe("Pick at least 3");
    expect(counter(sourcesInput())).toBe("0 selected");
  });

  it("opens a scrollable list of every item, labelled for screen readers", async () => {
    await renderForm();
    await open(topicsInput());

    const listbox = document.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute("aria-label")).toBe("Topics");
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    expect(optionLabels()).toEqual(PICKABLE_TOPICS);
  });

  it("selects an item with a click, showing a chip and a form value", async () => {
    await renderForm();
    await open(topicsInput());

    await act(async () => option(TOPICS[2])!.click());
    await flush();

    expect(chipLabels(topicsInput())).toEqual([TOPICS[2]]);
    expect(fieldValues("topics")).toEqual([TOPICS[2]]);
    expect(option(TOPICS[2])!.getAttribute("aria-selected")).toBe("true");
    expect(counter(topicsInput())).toBe("Pick at least 2 more");
  });

  it("filters as you type, and shows a no-match row when nothing matches", async () => {
    await renderForm();
    const input = topicsInput();
    await open(input);

    const target = TOPICS[TOPICS.length - 1];
    await type(input, target.slice(0, Math.min(target.length, 6)));
    const narrowed = optionLabels();
    expect(narrowed).toContain(target);
    expect(narrowed.length).toBeLessThan(PICKABLE_TOPICS.length);
    for (const label of narrowed) {
      expect(label!.toLowerCase()).toContain(target.slice(0, 6).toLowerCase());
    }

    await type(input, "zzqx-no-such-topic");
    expect(optionLabels()).toEqual([]);
    expect(document.querySelector('[data-slot="combobox-empty"]')!.textContent).toBe("No match.");

    await type(input, "");
    expect(optionLabels()).toEqual(PICKABLE_TOPICS);
    expect(document.querySelector('[data-slot="combobox-empty"]')!.textContent).toBe("");
  });

  it("removes a chip with its button, and keeps focus in the picker", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = topicsInput();

    const remove = document.querySelector<HTMLButtonElement>(
      `[aria-label="Remove ${TOPICS[1]}"]`
    )!;
    expect(remove).toBeTruthy();
    await act(async () => remove.click());
    await flush();

    expect(chipLabels(input)).toEqual([TOPICS[0], TOPICS[2]]);
    expect(fieldValues("topics")).toEqual([TOPICS[0], TOPICS[2]]);
    expect(document.activeElement).toBe(input);
  });

  it("is usable from the keyboard alone: pick, filter, remove, close", async () => {
    await renderForm();
    const input = topicsInput();

    // Open, move to the second item, pick it; the list stays open for more.
    await open(input);
    await key(input, "ArrowDown");
    await key(input, "Enter");
    await flush();
    const firstPick = chipLabels(input);
    expect(firstPick).toHaveLength(1);
    expect(document.activeElement).toBe(input);

    // Type to filter; the first match is highlighted, so Enter picks it.
    const target = TOPICS.find((t) => !firstPick.includes(t))!;
    await type(input, target);
    await key(input, "Enter");
    await flush();
    expect(chipLabels(input)).toEqual([...firstPick, target]);

    // Backspace in the empty input removes the last chip; focus stays put.
    await type(input, "");
    await key(input, "Backspace");
    await flush();
    expect(chipLabels(input)).toEqual(firstPick);
    expect(document.activeElement).toBe(input);

    // Arrow left onto the remaining chip, Delete removes it, focus returns.
    await key(input, "ArrowLeft");
    await flush();
    const chip = document.activeElement as HTMLElement;
    expect(chip.getAttribute("data-slot")).toBe("combobox-chip");
    await key(chip, "Delete");
    await flush();
    expect(chipLabels(input)).toEqual([]);
    expect(document.activeElement).toBe(input);

    // Escape closes the list.
    await open(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await key(input, "Escape");
    await flush();
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it(`stops the pick after ${MAX_TOPICS} topics in the UI`, async () => {
    await renderForm({ topics: TOPICS.slice(0, MAX_TOPICS) });
    const input = topicsInput();
    expect(counter(input)).toBe(`${MAX_TOPICS} of ${MAX_TOPICS}`);

    await open(input);
    const extra = option(TOPICS[MAX_TOPICS])!;
    expect(extra.getAttribute("aria-disabled")).toBe("true");
    expect(option(TOPICS[0])!.getAttribute("aria-disabled")).toBeNull();

    await act(async () => extra.click());
    await type(input, TOPICS[MAX_TOPICS]);
    await key(input, "ArrowDown");
    await key(input, "Enter");
    await flush();

    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, MAX_TOPICS));
    expect(document.querySelector('[role="status"]:not([data-slot])')).toBeNull();
  });

  it("frees a slot again when a topic is removed at the limit", async () => {
    await renderForm({ topics: TOPICS.slice(0, MAX_TOPICS) });
    await act(async () =>
      document.querySelector<HTMLButtonElement>(`[aria-label="Remove ${TOPICS[0]}"]`)!.click()
    );
    await open(topicsInput());
    expect(option(TOPICS[MAX_TOPICS])!.getAttribute("aria-disabled")).toBeNull();

    await act(async () => option(TOPICS[MAX_TOPICS])!.click());
    await flush();
    expect(fieldValues("topics")).toEqual([...TOPICS.slice(1, MAX_TOPICS), TOPICS[MAX_TOPICS]]);
  });

  it("keeps a saved selection over the limit, with a notice to trim it", async () => {
    const saved = TOPICS.slice(0, MAX_TOPICS + 3);
    await renderForm({ topics: saved });
    const input = topicsInput();

    expect(chipLabels(input)).toEqual(saved);
    expect(fieldValues("topics")).toEqual(saved);
    expect(counter(input)).toBe(`${MAX_TOPICS + 3} of ${MAX_TOPICS}`);
    const notice = () =>
      [...container.querySelectorAll('p[role="status"]')].find((p) =>
        p.textContent?.includes("Remove")
      );
    expect(notice()?.textContent).toBe(
      `You follow ${MAX_TOPICS + 3} topics; the limit is now ${MAX_TOPICS}. Remove 3 before you next save.`
    );

    for (const topic of saved.slice(0, 3)) {
      await act(async () =>
        document.querySelector<HTMLButtonElement>(`[aria-label="Remove ${topic}"]`)!.click()
      );
    }
    await flush();
    expect(notice()).toBeUndefined();
    expect(counter(input)).toBe(`${MAX_TOPICS} of ${MAX_TOPICS}`);
  });
});

// A browser submits a form when Enter is pressed in one of its text inputs
// unless the keydown is default-prevented. jsdom doesn't perform that
// implicit submission, so these assert on defaultPrevented: false here means
// a real browser would have saved the form mid-search.
describe("Enter while searching", () => {
  it("picks the first match without pressing ArrowDown, and doesn't submit", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = topicsInput();
    const target = TOPICS[TOPICS.length - 1];
    await act(async () => input.focus());
    await type(input, target);

    const firstMatch = optionLabels()[0]!;
    expect(await key(input, "Enter")).toBe(true);
    await flush();
    expect(chipLabels(input)).toEqual([...TOPICS.slice(0, 3), firstMatch]);
  });

  it("never removes a pick: Enter on an already-picked first match keeps it", async () => {
    // A search whose first match is already picked but which also matches
    // something else, computed so no catalog name is hard-coded.
    const query = TOPICS.find((t) => TOPICS.some((other) => other !== t && other.includes(t)))!;
    const picked = TOPICS.find((t) => t.includes(query))!;
    await renderForm({ topics: [TOPICS.find((t) => !t.includes(query))!, picked] });
    const before = fieldValues("topics");
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, query);
    expect(optionLabels()[0]).toBe(picked);
    expect(optionLabels().length).toBeGreaterThan(1);

    expect(await key(input, "Enter")).toBe(true);
    await flush();
    expect(fieldValues("topics")).toEqual(before);
  });

  it("keeps the last pick when the search is typed then deleted, then Enter", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, TOPICS[5]);
    await type(input, "");

    await key(input, "Enter");
    await flush();
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, 3));
  });

  it("still lets a click on a picked row remove it", async () => {
    await renderForm({ topics: TOPICS.slice(0, 4) });
    await open(topicsInput());
    await act(async () => option(TOPICS[1])!.click());
    await flush();
    expect(fieldValues("topics")).toEqual([TOPICS[0], TOPICS[2], TOPICS[3]]);
  });

  it("doesn't submit when nothing matches", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, "zzqx-no-such-topic");

    expect(await key(input, "Enter")).toBe(true);
    expect(chipLabels(input)).toEqual(TOPICS.slice(0, 3));
  });

  it("doesn't submit or pick when the only match is disabled at the limit", async () => {
    await renderForm({ topics: TOPICS.slice(0, MAX_TOPICS) });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, TOPICS[MAX_TOPICS]);

    expect(await key(input, "Enter")).toBe(true);
    await flush();
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, MAX_TOPICS));
  });

  it("leaves Enter in an empty search box to submit the form as usual", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = topicsInput();
    await act(async () => input.focus());

    expect(await key(input, "Enter")).toBe(false);
  });
});

describe("Escape", () => {
  it("never clears the picks, in either picker, open or closed", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3), sources: SOURCES.slice(0, 2) });

    for (const input of [topicsInput(), sourcesInput()]) {
      await act(async () => input.focus());
      await key(input, "Escape"); // list closed
      await open(input);
      await key(input, "Escape"); // list open
      await key(input, "Escape"); // closed again
      await flush();
    }

    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, 3));
    expect(fieldValues("preferredSources")).toEqual(SOURCES.slice(0, 2));
  });
});

describe("PreferencesForm submission", () => {
  it("submits one form entry per pick, under the names the actions read", async () => {
    await renderForm({ topics: TOPICS.slice(0, 2), sources: [SOURCES[0]] });

    await open(topicsInput());
    await act(async () => option(TOPICS[4])!.click());
    await key(topicsInput(), "Escape");
    await open(sourcesInput());
    await act(async () => option(SOURCES[3])!.click());
    await flush();

    const formData = await submit();
    expect(formData.getAll("topics")).toEqual([TOPICS[0], TOPICS[1], TOPICS[4]]);
    expect(formData.getAll("preferredSources")).toEqual([SOURCES[0], SOURCES[3]]);
    // Nothing else rides along: the search inputs have no name.
    expect([...new Set([...formData.keys()])].sort()).toEqual(["preferredSources", "topics"]);

    const parsed = ProfileInput.safeParse({
      topics: formData.getAll("topics"),
      preferredSources: formData.getAll("preferredSources"),
    });
    expect(parsed.success).toBe(true);
  });

  it("submits zero sources as no entries, which the schema accepts", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });

    const formData = await submit();
    expect(formData.getAll("preferredSources")).toEqual([]);
    expect(
      ProfileInput.safeParse({
        topics: formData.getAll("topics"),
        preferredSources: formData.getAll("preferredSources"),
      }).success
    ).toBe(true);
  });

  it("drops a removed chip from the submission", async () => {
    await renderForm({ topics: TOPICS.slice(0, 4), sources: SOURCES.slice(0, 2) });
    await act(async () =>
      document.querySelector<HTMLButtonElement>(`[aria-label="Remove ${SOURCES[0]}"]`)!.click()
    );

    const formData = await submit();
    expect(formData.getAll("topics")).toEqual(TOPICS.slice(0, 4));
    expect(formData.getAll("preferredSources")).toEqual([SOURCES[1]]);
  });
});

// jsdom implements requestSubmit; this guards against a silent no-op making
// every submission test above vacuous.
it("the harness really submits", async () => {
  const spy = vi.fn();
  await act(async () => {
    root.render(
      <PreferencesForm action={spy} defaultTopics={TOPICS.slice(0, 3)} submitLabel="Save" />
    );
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(spy).toHaveBeenCalledTimes(1);
});
