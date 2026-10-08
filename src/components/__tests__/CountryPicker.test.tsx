// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS, type Topic } from "@/types";

// The countries picker as a reader uses it: real Base UI Combobox, real DOM
// events, real form submission. COUNTRIES is mocked (the offered list is
// filled separately); readingUnits.ts reads the same mock.

vi.mock("@/config/countries", async (importActual) => ({
  ...(await importActual<typeof import("@/config/countries")>()),
  COUNTRIES: ["Kenya", "Morocco", "Nigeria", "Uganda", "Senegal", "Ghana"],
}));

const { COUNTRIES, COUNTRIES_TOPIC } = await import("@/config/countries");
const { MAX_READING_UNITS } = await import("@/lib/readingUnits");
const { PreferencesForm } = await import("@/components/PreferencesForm");

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

async function renderForm(defaults: { topics?: Topic[]; countries?: string[] } = {}) {
  await act(async () => {
    root.render(
      <PreferencesForm
        action={async (_previous, formData) => {
          submitted.push(formData);
        }}
        defaultTopics={defaults.topics}
        defaultCountries={defaults.countries}
        submitLabel="Save"
      />
    );
  });
}

const topicsInput = () => document.getElementById("preferences-topics") as HTMLInputElement;
const countriesInput = () => document.getElementById("preferences-countries") as HTMLInputElement | null;
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function key(target: Element, k: string) {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
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

async function open(input: HTMLInputElement) {
  await act(async () => input.focus());
  await key(input, "ArrowDown");
}

const option = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  );
const optionLabels = () =>
  [...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => o.textContent);
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);
const counter = () => document.getElementById("preferences-topics-count")!.textContent;
const trimNotice = () =>
  [...container.querySelectorAll('p[role="status"]')].find((p) => p.textContent?.includes("limit is now"));

async function pickWithClick(input: HTMLInputElement, label: string) {
  await open(input);
  await act(async () => option(label)!.click());
  await flush();
  await key(input, "Escape");
}

async function removeChip(label: string) {
  await act(async () =>
    document.querySelector<HTMLButtonElement>(`[aria-label="Remove ${label}"]`)!.click()
  );
  await flush();
}

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  return submitted.at(-1)!;
}

const plainTopics = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);

describe("the countries picker", () => {
  it("offers no Countries topic, and shows the countries picker from the start, empty", async () => {
    await renderForm({ topics: plainTopics.slice(0, 3) });
    await open(topicsInput());
    expect(optionLabels()).not.toContain(COUNTRIES_TOPIC);
    expect(optionLabels()).toEqual(plainTopics);
    expect(countriesInput()).not.toBeNull();
    expect(fieldValues("countries")).toEqual([]);
  });

  it("sits right below the topics picker, reads as optional, and shares its counter", async () => {
    await renderForm({ topics: plainTopics.slice(0, 3) });
    expect(counter()).toBe(`3 of ${MAX_READING_UNITS}`);

    const input = countriesInput()!;
    expect(document.querySelector('label[for="preferences-countries"]')!.textContent).toBe("Countries (optional)");
    // Right below: the next picker in document order after the topics one.
    const comboboxes = [...container.querySelectorAll('[role="combobox"]')];
    expect(comboboxes.indexOf(input)).toBe(comboboxes.indexOf(topicsInput()) + 1);

    // One counter: the countries picker has none of its own and is described by the shared one.
    expect(document.getElementById("preferences-countries-count")).toBeNull();
    expect(input.getAttribute("aria-describedby")!.split(" ")).toEqual([
      "preferences-countries-hint",
      "preferences-topics-count",
    ]);

    await open(input);
    expect(optionLabels()).toEqual([...COUNTRIES]);
  });

  it("submits one countries field per pick and no Countries topic, and each country counts as one", async () => {
    await renderForm({ topics: plainTopics.slice(0, 3) });
    const input = countriesInput()!;
    await pickWithClick(input, COUNTRIES[1]);
    await pickWithClick(input, COUNTRIES[3]);

    expect(counter()).toBe(`5 of ${MAX_READING_UNITS}`);
    expect(fieldValues("countries")).toEqual([COUNTRIES[1], COUNTRIES[3]]);

    const formData = await submit();
    expect(formData.getAll("countries")).toEqual([COUNTRIES[1], COUNTRIES[3]]);
    expect(formData.getAll("topics")).toEqual(plainTopics.slice(0, 3));
  });

  it("picks a country from the keyboard while searching without submitting", async () => {
    await renderForm({ topics: [...plainTopics.slice(0, 3), COUNTRIES_TOPIC] });
    const input = countriesInput()!;
    await act(async () => input.focus());
    await type(input, COUNTRIES[2].slice(0, 4));

    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("countries")).toEqual([COUNTRIES[2]]);
    expect(counter()).toBe(`4 of ${MAX_READING_UNITS}`);
  });

  it(`disables picks in both pickers once topics and countries reach ${MAX_READING_UNITS}`, async () => {
    const topics = plainTopics.slice(0, MAX_READING_UNITS - 3);
    await renderForm({ topics: [...topics, COUNTRIES_TOPIC], countries: COUNTRIES.slice(0, 2) });
    expect(counter()).toBe(`${MAX_READING_UNITS - 1} of ${MAX_READING_UNITS}`);

    await pickWithClick(countriesInput()!, COUNTRIES[2]);
    expect(counter()).toBe(`${MAX_READING_UNITS} of ${MAX_READING_UNITS}`);

    // Countries picker: an unpicked country is disabled; Enter on it picks nothing.
    const input = countriesInput()!;
    await open(input);
    expect(option(COUNTRIES[3])!.getAttribute("aria-disabled")).toBe("true");
    expect(option(COUNTRIES[0])!.getAttribute("aria-disabled")).toBeNull();
    await key(input, "Escape");
    await type(input, COUNTRIES[3]);
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("countries")).toEqual(COUNTRIES.slice(0, 3));
    await key(input, "Escape");

    // Topics picker: an unpicked topic is disabled too.
    await open(topicsInput());
    expect(option(plainTopics[MAX_READING_UNITS])!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => option(plainTopics[MAX_READING_UNITS])!.click());
    await flush();
    expect(fieldValues("topics")).toEqual(topics);
  });

  it("frees a slot in the topics picker when a country is removed", async () => {
    const topics = plainTopics.slice(0, MAX_READING_UNITS - 2);
    await renderForm({ topics: [...topics, COUNTRIES_TOPIC], countries: COUNTRIES.slice(0, 2) });
    expect(counter()).toBe(`${MAX_READING_UNITS} of ${MAX_READING_UNITS}`);

    await removeChip(COUNTRIES[0]);
    expect(counter()).toBe(`${MAX_READING_UNITS - 1} of ${MAX_READING_UNITS}`);
    await pickWithClick(topicsInput(), plainTopics[MAX_READING_UNITS]);
    expect(fieldValues("topics")).toEqual([...topics, plainTopics[MAX_READING_UNITS]]);
    expect(counter()).toBe(`${MAX_READING_UNITS} of ${MAX_READING_UNITS}`);
  });

  it("removing every country leaves the picker up, empty, and submits none", async () => {
    await renderForm({ topics: [...plainTopics.slice(0, 3), COUNTRIES_TOPIC], countries: COUNTRIES.slice(0, 3) });
    expect(counter()).toBe(`6 of ${MAX_READING_UNITS}`);

    for (const country of COUNTRIES.slice(0, 3)) await removeChip(country);
    expect(countriesInput()).not.toBeNull();
    expect(fieldValues("countries")).toEqual([]);
    expect(counter()).toBe(`3 of ${MAX_READING_UNITS}`);
    const formData = await submit();
    expect(formData.getAll("countries")).toEqual([]);
    expect(formData.getAll("topics")).toEqual(plainTopics.slice(0, 3));
  });

  it("Backspace in the topics picker removes the last topic and leaves the countries alone", async () => {
    await renderForm({ topics: [...plainTopics.slice(0, 3), COUNTRIES_TOPIC], countries: [COUNTRIES[0]] });
    const input = topicsInput();
    await act(async () => input.focus());
    await key(input, "Backspace");
    expect(fieldValues("topics")).toEqual(plainTopics.slice(0, 2));
    expect(fieldValues("countries")).toEqual([COUNTRIES[0]]);
    expect(counter()).toBe(`3 of ${MAX_READING_UNITS}`);
  });

  it("loads saved countries as the picker's defaults, with no Countries chip among the topics", async () => {
    await renderForm({ topics: [plainTopics[0], COUNTRIES_TOPIC], countries: [COUNTRIES[4], COUNTRIES[0]] });
    expect(fieldValues("countries")).toEqual([COUNTRIES[4], COUNTRIES[0]]);
    expect(fieldValues("topics")).toEqual([plainTopics[0]]);
    expect(document.querySelector(`[aria-label="Remove ${COUNTRIES_TOPIC}"]`)).toBeNull();
    expect(counter()).toBe(`3 of ${MAX_READING_UNITS}`);
  });

  it("shows the countries it is given whatever the topics: the profile read decides which to give", async () => {
    await renderForm({ topics: plainTopics.slice(0, 3), countries: [COUNTRIES[0]] });
    expect(fieldValues("countries")).toEqual([COUNTRIES[0]]);
    expect(counter()).toBe(`4 of ${MAX_READING_UNITS}`);
  });

  it("never clears countries on Escape, open or closed", async () => {
    await renderForm({ topics: [...plainTopics.slice(0, 3), COUNTRIES_TOPIC], countries: COUNTRIES.slice(0, 2) });
    const input = countriesInput()!;
    await act(async () => input.focus());
    await key(input, "Escape");
    await open(input);
    await key(input, "Escape");
    await key(input, "Escape");
    expect(fieldValues("countries")).toEqual(COUNTRIES.slice(0, 2));
  });

  it("shows one trim notice, counting countries, when a saved selection is over the limit", async () => {
    const topics = [...plainTopics.slice(0, MAX_READING_UNITS - 2), COUNTRIES_TOPIC];
    await renderForm({ topics, countries: COUNTRIES.slice(0, 4) });

    expect(counter()).toBe(`${MAX_READING_UNITS + 2} of ${MAX_READING_UNITS}`);
    const notices = [...container.querySelectorAll('p[role="status"]')].filter((p) =>
      p.textContent?.includes("limit is now")
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toBe(
      `You follow ${MAX_READING_UNITS + 2} topics and countries; the limit is now ${MAX_READING_UNITS}. Remove 2 before you next save.`
    );

    await removeChip(COUNTRIES[0]);
    await removeChip(COUNTRIES[1]);
    expect(trimNotice()).toBeUndefined();
  });
});
