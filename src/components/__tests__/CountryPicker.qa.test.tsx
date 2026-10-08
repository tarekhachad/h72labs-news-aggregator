// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS, type Topic } from "@/types";

vi.mock("@/config/countries", async (importActual) => ({
  ...(await importActual<typeof import("@/config/countries")>()),
  COUNTRIES: ["Kenya", "Morocco", "Nigeria", "Uganda", "Senegal", "Ghana", "Egypt", "Chad", "Mali", "Togo", "Niger"],
}));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PreferencesForm } = await import("@/components/PreferencesForm");
const { AT_LIMIT, chips, searchTopics, topicSearch } = await import("./topicGridKit");

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

const optionEl = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  );
const topicsList = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);
const counter = () => document.getElementById("preferences-topics-count")!.textContent;
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);
const notices = () =>
  [...container.querySelectorAll('p[role="status"]')].filter((p) => p.textContent?.includes("limit is now"));
const removeChip = async (label: string) => {
  await act(async () =>
    document.querySelector<HTMLButtonElement>(`[aria-label="Remove ${label}"]`)!.click()
  );
  await flush();
};
async function searchAndEnter(input: HTMLInputElement, text: string) {
  await act(async () => input.focus());
  await type(input, text);
  return key(input, "Enter");
}
async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  return submitted.at(-1)!;
}

describe("QA: countries picker keyboard rules", () => {
  it("Enter on an already-picked highlighted country never removes it", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Kenya"] });
    const input = countriesInput()!;
    expect(await searchAndEnter(input, "Kenya")).toBe(true);
    expect(fieldValues("countries")).toEqual(["Kenya"]);
    await key(input, "Enter");
    expect(fieldValues("countries")).toEqual(["Kenya"]);
    expect(submitted).toHaveLength(0);
  });

  it("a search for Countries in the topic grid matches nothing, and Enter neither picks nor submits", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Kenya"] });
    await searchTopics("Countries");
    expect(chips()).toHaveLength(0);
    expect(await key(topicSearch(), "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(topicsList.slice(0, 3));
    expect(fieldValues("countries")).toEqual(["Kenya"]);
    expect(submitted).toHaveLength(0);
  });

  it("at the limit, clicking or Entering a disabled country picks nothing and never submits", async () => {
    await renderForm({
      topics: [...topicsList.slice(0, 7), COUNTRIES_TOPIC],
      countries: ["Kenya", "Morocco", "Uganda"],
    });
    expect(counter()).toBe(AT_LIMIT);
    const input = countriesInput()!;
    await open(input);
    await act(async () => optionEl("Ghana")!.click());
    await flush();
    expect(fieldValues("countries")).toEqual(["Kenya", "Morocco", "Uganda"]);
    await key(input, "Escape");
    expect(await searchAndEnter(input, "Ghana")).toBe(true);
    expect(fieldValues("countries")).toEqual(["Kenya", "Morocco", "Uganda"]);
    expect(submitted).toHaveLength(0);
  });

  it("at the limit from topics alone, no country can be added by click or Enter", async () => {
    await renderForm({ topics: topicsList.slice(0, 10) });
    expect(counter()).toBe(AT_LIMIT);
    const input = countriesInput()!;
    await open(input);
    expect(optionEl("Kenya")!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => optionEl("Kenya")!.click());
    await flush();
    expect(fieldValues("countries")).toEqual([]);
    await key(input, "Escape");
    expect(await searchAndEnter(input, "Kenya")).toBe(true);
    expect(fieldValues("countries")).toEqual([]);
    expect(submitted).toHaveLength(0);
  });

  it("Backspace in the closed countries input removes the last country, and no topic", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Kenya", "Morocco"] });
    const input = countriesInput()!;
    await act(async () => input.focus());
    await key(input, "Backspace");
    expect(fieldValues("countries")).toEqual(["Kenya"]);
    expect(fieldValues("topics")).toEqual(topicsList.slice(0, 3));
    expect(counter()).toBe("4 of 10");
  });

  it("Escape in the topic search keeps every topic and country, with or without search text", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Kenya"] });
    const input = topicSearch();
    await act(async () => input.focus());
    await key(input, "Escape");
    await searchTopics(topicsList[0]);
    await key(input, "Escape");
    await key(input, "Escape");
    expect(fieldValues("topics")).toEqual(topicsList.slice(0, 3));
    expect(fieldValues("countries")).toEqual(["Kenya"]);
  });
});

describe("QA: cross-picker state", () => {
  it("clicking picked rows in the open countries list unpicks them, down to none submitted", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Kenya", "Ghana"] });
    await open(countriesInput()!);
    await act(async () => optionEl("Kenya")!.click());
    await flush();
    expect(fieldValues("countries")).toEqual(["Ghana"]);
    expect(counter()).toBe("4 of 10");
    await act(async () => optionEl("Ghana")!.click());
    await flush();
    expect(countriesInput()).not.toBeNull();
    expect(fieldValues("countries")).toEqual([]);
    expect(counter()).toBe("3 of 10");
    const formData = await submit();
    expect(formData.getAll("countries")).toEqual([]);
    expect(formData.getAll("topics")).toEqual(topicsList.slice(0, 3));
  });

  it("over-limit saved selection: one notice, then none once enough countries are removed", async () => {
    await renderForm({
      topics: [...topicsList.slice(0, 9), COUNTRIES_TOPIC],
      countries: ["Kenya", "Morocco", "Uganda", "Ghana"],
    });
    expect(counter()).toBe("13 of 10");
    expect(notices()).toHaveLength(1);
    expect(countriesInput()!.getAttribute("aria-describedby")).toContain("preferences-topics-count");
    for (const country of ["Kenya", "Morocco", "Uganda"]) await removeChip(country);
    expect(notices()).toHaveLength(0);
    expect(counter()).toBe(AT_LIMIT);
  });

  it("over-limit: no new pick in the countries picker, removals still work", async () => {
    await renderForm({
      topics: [...topicsList.slice(0, 9), COUNTRIES_TOPIC],
      countries: ["Kenya", "Morocco", "Uganda", "Ghana"],
    });
    await open(countriesInput()!);
    await act(async () => optionEl("Egypt")!.click());
    await flush();
    expect(fieldValues("countries")).toHaveLength(4);
    await removeChip("Kenya");
    expect(counter()).toBe("12 of 10");
    expect(fieldValues("countries")).toEqual(["Morocco", "Uganda", "Ghana"]);
  });

  it("duplicate saved countries submit once, as they are counted", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Kenya", "Kenya"] });
    expect(counter()).toBe("4 of 10");
    expect(fieldValues("countries")).toEqual(["Kenya"]);
  });

  it("a saved country missing from the offered list is counted and submitted consistently", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Atlantis"] });
    expect(counter()).toBe("4 of 10");
    expect(fieldValues("countries")).toEqual(["Atlantis"]);
  });

  it("a country removed and picked again counts again", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Kenya"] });
    await removeChip("Kenya");
    expect(counter()).toBe("3 of 10");
    await open(countriesInput()!);
    await act(async () => optionEl("Kenya")!.click());
    await flush();
    expect(fieldValues("countries")).toEqual(["Kenya"]);
    expect(counter()).toBe("4 of 10");
  });

  it("a saved Countries topic with zero countries adds nothing to the counter and shows no chip", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 2), COUNTRIES_TOPIC] });
    expect(counter()).toBe("Pick at least one more");
    expect(fieldValues("topics")).toEqual(topicsList.slice(0, 2));
  });

  it("submit: getAll(countries) matches picks in order", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC], countries: ["Morocco", "Kenya"] });
    expect((await submit()).getAll("countries")).toEqual(["Morocco", "Kenya"]);
  });

  it("with empty COUNTRIES the countries picker still renders without crashing", async () => {
    await renderForm({ topics: [...topicsList.slice(0, 3), COUNTRIES_TOPIC] });
    expect(countriesInput()).not.toBeNull();
    await open(countriesInput()!);
    expect(optionEl("Kenya")).toBeDefined();
  });
});
