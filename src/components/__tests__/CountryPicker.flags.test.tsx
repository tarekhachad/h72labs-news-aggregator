// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS, type Topic } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";
import { PreferencesForm } from "@/components/PreferencesForm";

// Each country shows its SVG flag before its name, in the list and in its
// chip. The flag is decorative: it adds no text, screen readers skip it, and
// searching still matches the name.

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

async function renderForm(countries: string[] = []) {
  const topics: Topic[] = plain.slice(0, 3);
  if (countries.length > 0) topics.push(COUNTRIES_TOPIC);
  await act(async () => {
    root.render(
      <PreferencesForm action={async () => {}} defaultTopics={topics} defaultCountries={countries} submitLabel="Save" />
    );
  });
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const countriesInput = () => document.getElementById("preferences-countries") as HTMLInputElement;

async function key(target: Element, k: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

async function open(input: HTMLInputElement) {
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  await flush();
}

async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
  await flush();
}

const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const chips = () => [...container.querySelectorAll<HTMLElement>('[data-slot="combobox-chip"]')];

function expectDecorativeFlagBeforeName(el: HTMLElement, name: string) {
  const flag = el.querySelector('svg[data-slot="country-flag"]');
  expect(flag, `${name} has a flag`).not.toBeNull();
  expect(flag!.getAttribute("aria-hidden")).toBe("true");
  expect(flag!.querySelector("title")).toBeNull();
  expect(flag!.textContent).toBe("");
  // The flag comes before the name's text.
  const nameNode = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent === name)!;
  expect(flag!.compareDocumentPosition(nameNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe("country flags", () => {
  it("shows a flag before every country in the list, adding no text", async () => {
    await renderForm();
    await open(countriesInput());
    const rows = options();
    expect(rows.map((r) => r.textContent)).toEqual([...COUNTRIES]);
    for (const row of rows) expectDecorativeFlagBeforeName(row, row.textContent!);
  });

  it("shows a flag before the name in each picked country's chip", async () => {
    await renderForm(["Morocco", "Japan"]);
    const countryChips = chips().filter((c) => ["Morocco", "Japan"].some((n) => c.textContent === n));
    expect(countryChips).toHaveLength(2);
    for (const chip of countryChips) expectDecorativeFlagBeforeName(chip, chip.textContent!);
    expect(container.querySelector('[aria-label="Remove Morocco"]')).not.toBeNull();
  });

  it("draws no flag in the topic grid or the sources picker", async () => {
    await renderForm();
    const topicChips = [...container.querySelectorAll<HTMLElement>('[data-slot="topic-chip"]')];
    expect(topicChips.filter((c) => c.getAttribute("aria-pressed") === "true")).toHaveLength(3);
    for (const chip of topicChips) expect(chip.querySelector('[data-slot="country-flag"]')).toBeNull();
    await open(document.getElementById("preferences-sources") as HTMLInputElement);
    expect(document.querySelector('[role="listbox"] svg[data-slot="country-flag"]')).toBeNull();
  });

  it("still finds Morocco when searching 'Mor', with its flag", async () => {
    await renderForm();
    await open(countriesInput());
    await type(countriesInput(), "Mor");
    const rows = options();
    expect(rows.map((r) => r.textContent)).toEqual(["Morocco"]);
    expectDecorativeFlagBeforeName(rows[0], "Morocco");
  });
});
