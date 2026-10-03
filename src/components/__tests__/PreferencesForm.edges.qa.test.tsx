// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { MAX_TOPICS, ProfileInput } from "@/lib/profile";
import { PreferencesForm } from "@/components/PreferencesForm";

// QA edge cases for the preferences pickers: the limit guard under filtering
// and over-limit saved selections, focus after chip removal in the positions
// the main suite doesn't cover, re-picks and repeated submissions. Every name
// is TOPICS/SOURCES by position.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
        action={(formData) => {
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

async function key(target: Element, k: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await flush();
}

async function open(input: HTMLInputElement) {
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  await flush();
}

const optionLabels = () =>
  [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent);
const option = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  );
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);
const chipsRoot = (input: HTMLInputElement) =>
  input.closest('[data-slot="combobox-chips"]') as HTMLElement;
const chipLabels = (input: HTMLInputElement) =>
  [...chipsRoot(input).querySelectorAll('[data-slot="combobox-chip"]')].map((c) => c.textContent);
const counter = (input: HTMLInputElement) =>
  document.getElementById(`${input.id}-count`)!.textContent;
const removeButton = (label: string) =>
  document.querySelector<HTMLButtonElement>(`[aria-label="Remove ${label}"]`)!;

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  return submitted.at(-1)!;
}

describe("limit guard", () => {
  it("after a filtered pick of the 10th, filtering again shows the rest disabled and unpickable", async () => {
    await renderForm({ topics: TOPICS.slice(0, MAX_TOPICS - 1) });
    const input = topicsInput();
    const tenth = TOPICS[MAX_TOPICS - 1];
    const eleventh = TOPICS[MAX_TOPICS];

    await open(input);
    await type(input, tenth);
    expect(optionLabels()).toContain(tenth);
    await key(input, "ArrowDown");
    await key(input, "Enter");
    await flush();
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, MAX_TOPICS));
    expect(counter(input)).toBe(`${MAX_TOPICS} of ${MAX_TOPICS}`);

    // Same open list, new filter: the 11th is shown, disabled, and unpickable.
    await type(input, eleventh);
    const extra = option(eleventh);
    expect(extra).toBeTruthy();
    expect(extra!.getAttribute("aria-disabled")).toBe("true");
    // A disabled match is not "No match."
    expect(document.querySelector('[data-slot="combobox-empty"]')!.textContent).toBe("");
    await key(input, "ArrowDown");
    await key(input, "Enter");
    await act(async () => extra!.click());
    await flush();
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, MAX_TOPICS));
  });

  it("over the limit, removing one still blocks new picks until under 10", async () => {
    const saved = TOPICS.slice(0, MAX_TOPICS + 2);
    const unpicked = TOPICS[MAX_TOPICS + 2];
    expect(unpicked).toBeTruthy();
    await renderForm({ topics: saved });
    const input = topicsInput();

    await act(async () => removeButton(saved[0]).click());
    await flush();
    expect(fieldValues("topics")).toHaveLength(MAX_TOPICS + 1);

    await open(input);
    expect(option(unpicked)!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => option(unpicked)!.click());
    await type(input, unpicked);
    await key(input, "ArrowDown");
    await key(input, "Enter");
    await flush();
    expect(fieldValues("topics")).toEqual(saved.slice(1));
    expect(counter(input)).toBe(`${MAX_TOPICS + 1} of ${MAX_TOPICS}`);
  });

  it("over the limit, a selected item in the list can still be clicked off", async () => {
    const saved = TOPICS.slice(0, MAX_TOPICS + 1);
    await renderForm({ topics: saved });
    const input = topicsInput();
    await open(input);

    const picked = option(saved[4])!;
    expect(picked.getAttribute("aria-disabled")).toBeNull();
    await act(async () => picked.click());
    await flush();
    expect(fieldValues("topics")).toEqual(saved.filter((t) => t !== saved[4]));
    expect(counter(input)).toBe(`${MAX_TOPICS} of ${MAX_TOPICS}`);
    // At exactly the limit now: notice gone, unpicked still disabled.
    expect(
      [...container.querySelectorAll('p[role="status"]')].find((p) => p.textContent?.includes("limit is now"))
    ).toBeUndefined();
    expect(option(TOPICS[MAX_TOPICS + 1])!.getAttribute("aria-disabled")).toBe("true");
  });

  it("the topics limit never disables the sources picker", async () => {
    expect(SOURCES.length).toBeGreaterThan(MAX_TOPICS);
    await renderForm({ topics: TOPICS.slice(0, MAX_TOPICS), sources: SOURCES.slice(0, MAX_TOPICS) });
    const input = sourcesInput();
    await open(input);
    const next = option(SOURCES[MAX_TOPICS])!;
    expect(next.getAttribute("aria-disabled")).toBeNull();
    await act(async () => next.click());
    await flush();
    expect(fieldValues("preferredSources")).toEqual(SOURCES.slice(0, MAX_TOPICS + 1));
    expect(counter(input)).toBe(`${MAX_TOPICS + 1} selected`);
    // No trim notice for sources: they have no max.
    expect(
      [...container.querySelectorAll('p[role="status"]')].find((p) => p.textContent?.includes("limit is now"))
    ).toBeUndefined();
  });
});

describe("focus after removing a chip", () => {
  it("removing the only chip with its button leaves focus in the input", async () => {
    await renderForm({ topics: [TOPICS[0]] });
    const input = topicsInput();
    await act(async () => removeButton(TOPICS[0]).click());
    await flush();
    expect(chipLabels(input)).toEqual([]);
    expect(document.activeElement).toBe(input);
  });

  it("removing the first chip with its button leaves focus in the input", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = topicsInput();
    await act(async () => removeButton(TOPICS[0]).click());
    await flush();
    expect(chipLabels(input)).toEqual([TOPICS[1], TOPICS[2]]);
    expect(document.activeElement).toBe(input);
  });

  it.each(["Delete", "Backspace"])(
    "removing a middle chip from the keyboard (%s) keeps focus inside the picker",
    async (k) => {
      await renderForm({ topics: TOPICS.slice(0, 3) });
      const input = topicsInput();
      await act(async () => input.focus());
      await key(input, "ArrowLeft");
      await flush();
      await key(document.activeElement!, "ArrowLeft");
      await flush();
      const chip = document.activeElement as HTMLElement;
      expect(chip.getAttribute("data-slot")).toBe("combobox-chip");
      expect(chip.textContent).toBe(TOPICS[1]);

      await key(chip, k);
      await flush();
      expect(chipLabels(input)).toEqual([TOPICS[0], TOPICS[2]]);
      expect(fieldValues("topics")).toEqual([TOPICS[0], TOPICS[2]]);
      const active = document.activeElement as HTMLElement;
      expect(active).not.toBe(document.body);
      expect(chipsRoot(input).contains(active)).toBe(true);
    }
  );

  it("removing the last chip of the sources picker keeps focus in that picker", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3), sources: [SOURCES[0]] });
    const input = sourcesInput();
    await act(async () => input.focus());
    await key(input, "Backspace");
    await flush();
    expect(fieldValues("preferredSources")).toEqual([]);
    expect(document.activeElement).toBe(input);
    // And the topics picker is untouched.
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, 3));
  });
});

describe("re-picks and submissions", () => {
  it("clicking an already-picked option toggles it off rather than duplicating it", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    const input = topicsInput();
    await open(input);
    await act(async () => option(TOPICS[1])!.click());
    await flush();
    expect(fieldValues("topics")).toEqual([TOPICS[0], TOPICS[2]]);
    await act(async () => option(TOPICS[1])!.click());
    await flush();
    const values = fieldValues("topics");
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual([...TOPICS.slice(0, 3)].sort());
  });

  it("submitting twice sends the same, duplicate-free picks both times", async () => {
    await renderForm({ topics: TOPICS.slice(0, 4), sources: SOURCES.slice(0, 2) });
    const first = await submit();
    const second = await submit();
    expect(submitted).toHaveLength(2);
    for (const fd of [first, second]) {
      expect(fd.getAll("topics")).toEqual(TOPICS.slice(0, 4));
      expect(fd.getAll("preferredSources")).toEqual(SOURCES.slice(0, 2));
    }
  });

  it("one hidden field per chip, all inside the form", async () => {
    await renderForm({ topics: TOPICS.slice(0, 5), sources: SOURCES.slice(0, 3) });
    const form = container.querySelector("form")!;
    const hiddenTopics = document.querySelectorAll('input[name="topics"]');
    expect(hiddenTopics).toHaveLength(5);
    for (const el of hiddenTopics) expect(form.contains(el)).toBe(true);
    expect(chipLabels(topicsInput())).toHaveLength(5);
    expect(chipLabels(sourcesInput())).toHaveLength(3);
  });

  it("submitting an over-limit selection reaches the action, where the schema rejects it", async () => {
    await renderForm({ topics: TOPICS.slice(0, MAX_TOPICS + 1) });
    const fd = await submit();
    expect(fd.getAll("topics")).toHaveLength(MAX_TOPICS + 1);
    const parsed = ProfileInput.safeParse({
      topics: fd.getAll("topics"),
      preferredSources: fd.getAll("preferredSources"),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(`Pick at most ${MAX_TOPICS} topics`);
  });

  it("zero topics submits no topic field, which the schema rejects with the minimum message", async () => {
    await renderForm();
    const fd = await submit();
    expect(fd.getAll("topics")).toEqual([]);
    const parsed = ProfileInput.safeParse({
      topics: fd.getAll("topics"),
      preferredSources: fd.getAll("preferredSources"),
    });
    expect(parsed.error?.issues[0]?.message).toBe("Pick at least 3 topics");
  });

  it("filter text typed in the search box is not submitted", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    await open(topicsInput());
    await type(topicsInput(), "zzqx");
    const fd = await submit();
    expect(fd.getAll("topics")).toEqual(TOPICS.slice(0, 3));
    for (const v of fd.values()) expect(v).not.toBe("zzqx");
  });
});
