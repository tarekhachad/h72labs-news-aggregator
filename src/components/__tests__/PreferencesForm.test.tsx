// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { MAX_TOPICS, ProfileInput } from "@/lib/profile";
import { PreferencesForm } from "@/components/PreferencesForm";
import { TOPIC_GROUPS } from "@/config/topicGroups";
import { TOPIC_DESCRIPTIONS } from "@/config/topicDescriptions";
import { AT_LIMIT, chip, chipNames, chips, clickChip, isPicked, searchTopics, topicSearch } from "./topicGridKit";

// The single-page preferences form (/profile) as a reader uses it: the topic
// grid, the real Base UI sources picker, and a real form submission whose
// FormData is what the profile action receives. No names are hard-coded: the
// catalog grows and is renamed, so every pick is TOPICS/SOURCES by position.
// The dropdown's own rules (Enter only adds, Escape never clears) are pinned
// on MultiSelect in MultiSelect.enter/guards.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The grid offers every topic but Countries, which has its own picker.
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

async function open(input: HTMLInputElement) {
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  await flush();
}

const option = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  );

/** Values the form would submit under `name`, read from the DOM. */
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

const counter = () => document.getElementById("preferences-topics-count")!.textContent;
const saveButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((b) => b.textContent === "Save")!;
const trimNotice = () =>
  [...container.querySelectorAll('p[role="status"]')].find((p) => p.textContent?.includes("Remove"));

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  return submitted.at(-1)!;
}

describe("the topic grid", () => {
  it("labels the grid and the sources picker, and describes their limits", async () => {
    await renderForm();
    const grid = container.querySelector<HTMLElement>('[role="group"][aria-labelledby="preferences-topics-label"]')!;
    expect(document.getElementById("preferences-topics-label")!.textContent).toBe("Topics");
    expect(grid.getAttribute("aria-describedby")!.split(" ")).toEqual([
      "preferences-topics-hint",
      "preferences-topics-count",
    ]);
    expect(document.getElementById("preferences-topics-hint")!.textContent).toContain(`Pick 3 to ${MAX_TOPICS}`);
    expect(counter()).toBe("Pick at least 3");

    const sources = sourcesInput();
    expect(sources.getAttribute("role")).toBe("combobox");
    expect(document.querySelector(`label[for="${sources.id}"]`)?.textContent).toBe("Preferred sources");
    expect(document.getElementById("preferences-sources-hint")!.textContent).toContain("Optional");
    expect(document.getElementById("preferences-sources-count")!.textContent).toBe("0 selected");
  });

  it("shows every pickable topic as a chip under the six groups, each with its description", async () => {
    await renderForm();
    const headings = [...container.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual(TOPIC_GROUPS.map((g) => g.name));
    expect(chipNames()).toEqual(TOPIC_GROUPS.flatMap((g) => g.topics));
    expect([...chipNames()].sort()).toEqual([...PICKABLE_TOPICS].sort());
    for (const c of chips()) {
      const name = document.getElementById(c.getAttribute("aria-labelledby")!)!.textContent!;
      const description = document.getElementById(c.getAttribute("aria-describedby")!)!.textContent;
      expect(description).toBe(TOPIC_DESCRIPTIONS[name as keyof typeof TOPIC_DESCRIPTIONS]);
    }
  });

  it("chips are real buttons that never submit, with a pressed state", async () => {
    await renderForm();
    for (const c of chips()) {
      expect(c.tagName).toBe("BUTTON");
      expect(c.type).toBe("button");
      expect(c.getAttribute("aria-pressed")).toBe("false");
      expect(c.tabIndex).toBe(0);
    }
  });

  it("picks a topic with a click, as a pressed chip and a form value", async () => {
    await renderForm();
    await clickChip(TOPICS[2]);
    expect(isPicked(TOPICS[2])).toBe(true);
    expect(fieldValues("topics")).toEqual([TOPICS[2]]);
    expect(counter()).toBe("Pick at least 2 more");
    expect(submitted).toHaveLength(0);
  });

  it("unpicks a topic with a second click", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    await clickChip(TOPICS[1]);
    expect(isPicked(TOPICS[1])).toBe(false);
    expect(fieldValues("topics")).toEqual([TOPICS[0], TOPICS[2]]);
  });

  it("filters the grid as you type, by name or description, with a no-match line", async () => {
    await renderForm();
    const target = PICKABLE_TOPICS[PICKABLE_TOPICS.length - 1];
    await searchTopics(target.slice(0, 6));
    expect(chipNames()).toContain(target);
    expect(chipNames().length).toBeLessThan(PICKABLE_TOPICS.length);

    // A word only in a description finds its topic.
    const [topic, description] = Object.entries(TOPIC_DESCRIPTIONS).find(
      ([name, line]) => !name.toLowerCase().includes(line.split(" ").at(-1)!.toLowerCase())
    )!;
    await searchTopics(description.split(" ").at(-1)!);
    expect(chipNames()).toContain(topic);

    await searchTopics("zzqx-no-such-topic");
    expect(chipNames()).toEqual([]);
    expect(container.textContent).toContain("No topic matches “zzqx-no-such-topic”.");

    await searchTopics("");
    expect(chipNames()).toHaveLength(PICKABLE_TOPICS.length);
  });

  it("ignores case and accents in the search", async () => {
    await renderForm();
    const accented = Object.entries(TOPIC_DESCRIPTIONS).find(([, line]) => /[À-ÿ]/.test(line));
    expect(accented).toBeDefined();
    const word = accented![1].split(/\s+/).find((w) => /[À-ÿ]/.test(w))!.replace(/[^\p{L}-]/gu, "");
    await searchTopics(word.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase());
    expect(chipNames()).toContain(accented![0]);
  });

  it("Enter in the search box never submits and never picks", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    await searchTopics(TOPICS[5]);
    expect(await key(topicSearch(), "Enter")).toBe(true);
    await searchTopics("");
    expect(await key(topicSearch(), "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, 3));
    expect(submitted).toHaveLength(0);
  });

  it(`stops picks at ${MAX_TOPICS}, with the reason in the counter`, async () => {
    await renderForm({ topics: TOPICS.slice(0, MAX_TOPICS) });
    expect(counter()).toBe(AT_LIMIT);
    const extra = chip(TOPICS[MAX_TOPICS])!;
    expect(extra.getAttribute("aria-disabled")).toBe("true");
    expect(extra.getAttribute("aria-describedby")).toContain("preferences-topics-count");
    expect(chip(TOPICS[0])!.getAttribute("aria-disabled")).toBeNull();

    await clickChip(TOPICS[MAX_TOPICS]);
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, MAX_TOPICS));
    expect(trimNotice()).toBeUndefined();
  });

  it("frees a slot again when a topic is removed at the limit", async () => {
    await renderForm({ topics: TOPICS.slice(0, MAX_TOPICS) });
    await clickChip(TOPICS[0]);
    expect(chip(TOPICS[MAX_TOPICS])!.getAttribute("aria-disabled")).toBeNull();
    await clickChip(TOPICS[MAX_TOPICS]);
    expect(fieldValues("topics")).toEqual([...TOPICS.slice(1, MAX_TOPICS), TOPICS[MAX_TOPICS]]);
  });

  it("keeps a saved selection over the limit, with a notice to trim it", async () => {
    const saved = TOPICS.slice(0, MAX_TOPICS + 3);
    await renderForm({ topics: saved });
    expect(fieldValues("topics")).toEqual(saved);
    expect(counter()).toBe(`${MAX_TOPICS + 3} of ${MAX_TOPICS}`);
    expect(trimNotice()?.textContent).toBe(
      `You follow ${MAX_TOPICS + 3} topics; the limit is now ${MAX_TOPICS}. Remove 3 before you next save.`
    );
    // Over the limit nothing new can be added.
    const unpicked = PICKABLE_TOPICS.find((t) => !saved.includes(t))!;
    expect(chip(unpicked)!.getAttribute("aria-disabled")).toBe("true");
    await clickChip(unpicked);
    expect(fieldValues("topics")).toEqual(saved);

    for (const topic of saved.slice(0, 3)) await clickChip(topic);
    expect(trimNotice()).toBeUndefined();
    expect(counter()).toBe(AT_LIMIT);
  });

  it("shows no starter sets on the single-page form", async () => {
    await renderForm();
    expect(container.textContent).not.toContain("Start from a set");
  });
});

describe("Save below the minimum", () => {
  it("is disabled with the reason beside it, and comes back once there are enough", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute("aria-describedby")).toBeNull();

    await clickChip(TOPICS[2]);
    expect(saveButton().disabled).toBe(true);
    const reason = document.getElementById(saveButton().getAttribute("aria-describedby")!)!;
    expect(reason.textContent).toBe("Pick at least 1 more topic to save. Each country counts as one.");

    await clickChip(TOPICS[1]);
    expect(document.getElementById(saveButton().getAttribute("aria-describedby")!)!.textContent).toBe(
      "Pick at least 2 more topics to save. Each country counts as one."
    );

    await clickChip(TOPICS[1]);
    await clickChip(TOPICS[2]);
    expect(saveButton().disabled).toBe(false);
  });
});

describe("the sources picker", () => {
  it("never clears its picks on Escape, open or closed", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3), sources: SOURCES.slice(0, 2) });
    const input = sourcesInput();
    await act(async () => input.focus());
    await key(input, "Escape");
    await open(input);
    await key(input, "Escape");
    await key(input, "Escape");
    await flush();
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, 3));
    expect(fieldValues("preferredSources")).toEqual(SOURCES.slice(0, 2));
  });
});

describe("PreferencesForm submission", () => {
  it("submits one form entry per pick, under the names the actions read", async () => {
    await renderForm({ topics: TOPICS.slice(0, 2), sources: [SOURCES[0]] });

    await clickChip(TOPICS[4]);
    await open(sourcesInput());
    await act(async () => option(SOURCES[3])!.click());
    await flush();

    const formData = await submit();
    expect(formData.getAll("topics")).toEqual([TOPICS[0], TOPICS[1], TOPICS[4]]);
    expect(formData.getAll("preferredSources")).toEqual([SOURCES[0], SOURCES[3]]);
    // Nothing else rides along: the search boxes have no name.
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

  it("drops an unpicked topic and a removed source from the submission", async () => {
    await renderForm({ topics: TOPICS.slice(0, 4), sources: SOURCES.slice(0, 2) });
    await clickChip(TOPICS[3]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(`[aria-label="Remove ${SOURCES[0]}"]`)!.click()
    );

    const formData = await submit();
    expect(formData.getAll("topics")).toEqual(TOPICS.slice(0, 3));
    expect(formData.getAll("preferredSources")).toEqual([SOURCES[1]]);
  });

  it("still submits picks the search has hidden", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3) });
    await searchTopics("zzqx-no-such-topic");
    const formData = await submit();
    expect(formData.getAll("topics")).toEqual(TOPICS.slice(0, 3));
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
