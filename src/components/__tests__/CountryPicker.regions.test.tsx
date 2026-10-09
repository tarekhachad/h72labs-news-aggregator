// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS, type Topic } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { COUNTRY_REGIONS } from "@/config/countryRegions";
import { PreferencesForm } from "@/components/PreferencesForm";

// The countries list grouped under five regions: search filters inside every
// region and hides one left empty, and the picker's keyboard rules hold with
// groups (Enter while searching picks and never submits, Escape never clears
// a pick, keyboard Enter only adds).

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
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await flush();
  return event.defaultPrevented;
}

async function open(input: HTMLInputElement) {
  await act(async () => input.focus());
  await key(input, "ArrowDown");
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

const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const groups = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="group"]')];
const groupName = (group: HTMLElement) => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent;
const optionsIn = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent);
const picked = () =>
  [...container.querySelectorAll<HTMLInputElement>('input[name="countries"]')].map((i) => i.value).filter(Boolean);

describe("countries grouped by region", () => {
  it("lists every country under its region, the five regions in order", async () => {
    await renderForm();
    await open(countriesInput());
    expect(groups().map(groupName)).toEqual(["Africa", "Americas", "Asia-Pacific", "Europe", "Middle East"]);
    for (const [index, group] of groups().entries()) {
      expect(optionsIn(group)).toEqual([...COUNTRY_REGIONS[index].countries]);
    }
    // A region's label is a group label, not a pickable row.
    expect(optionsIn(listbox()!)).not.toContain("Africa");
  });

  it("filters inside every region and hides a region left empty", async () => {
    await renderForm();
    await open(countriesInput());
    await type(countriesInput(), "jap");
    expect(groups().map(groupName)).toEqual(["Asia-Pacific"]);
    expect(optionsIn(listbox()!)).toEqual(["Japan"]);

    await type(countriesInput(), "ia");
    const names = groups().map(groupName);
    expect(names).toEqual(expect.arrayContaining(["Africa", "Asia-Pacific", "Europe", "Middle East"]));
    expect(names).not.toContain("Americas");
    for (const group of groups()) expect(optionsIn(group).length).toBeGreaterThan(0);
  });

  it("says no match, with no region left, when nothing matches", async () => {
    await renderForm();
    await open(countriesInput());
    await type(countriesInput(), "zzzz");
    expect(groups()).toHaveLength(0);
    expect(document.querySelector('[data-slot="combobox-empty"]')?.textContent).toBe("No match.");
  });

  it("Enter while searching picks the first match across regions and never submits", async () => {
    await renderForm();
    await open(countriesInput());
    await type(countriesInput(), "mor");
    expect(await key(countriesInput(), "Enter")).toBe(true);
    expect(picked()).toEqual(["Morocco"]);
  });

  it("Enter with no match is held, so a half-typed search never saves", async () => {
    await renderForm(["Japan"]);
    await open(countriesInput());
    await type(countriesInput(), "zzzz");
    expect(await key(countriesInput(), "Enter")).toBe(true);
    expect(picked()).toEqual(["Japan"]);
  });

  it("keyboard Enter only adds: on a picked country it keeps the pick", async () => {
    await renderForm(["Japan"]);
    await open(countriesInput());
    await type(countriesInput(), "japan");
    await key(countriesInput(), "Enter");
    expect(picked()).toEqual(["Japan"]);
  });

  it("Escape never clears the picks, open or closed", async () => {
    await renderForm(["Japan", "Morocco"]);
    await open(countriesInput());
    await key(countriesInput(), "Escape");
    await key(countriesInput(), "Escape");
    await key(countriesInput(), "Escape");
    expect(picked()).toEqual(["Japan", "Morocco"]);
  });

  it("shows no section heading over the regions", async () => {
    await renderForm();
    await open(countriesInput());
    expect(document.querySelector('[data-slot="combobox-section"]')).toBeNull();
  });
});
