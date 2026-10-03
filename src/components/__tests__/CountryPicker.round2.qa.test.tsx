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
        action={(formData) => {
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


const errorSpy = vi.spyOn(console, "error");
const dupWarnings = () =>
  errorSpy.mock.calls.filter((c) => /same key|unique "key"/i.test(String(c[0]) + String(c[1] ?? "")));
const base = [...topicsList.slice(0, 3), COUNTRIES_TOPIC];

describe("QA round 2: duplicate saved countries", () => {
  beforeEach(() => errorSpy.mockClear());

  it("dedupe keeps first-occurrence order, one chip each, no key warning", async () => {
    await renderForm({ topics: base, countries: ["Morocco", "Kenya", "Morocco", "Uganda", "Kenya", "Kenya"] });
    expect(fieldValues("countries")).toEqual(["Morocco", "Kenya", "Uganda"]);
    expect(document.querySelectorAll('[aria-label="Remove Kenya"]')).toHaveLength(1);
    expect(counter()).toBe("6 of 10");
    expect(dupWarnings()).toHaveLength(0);
    expect((await submit()).getAll("countries")).toEqual(["Morocco", "Kenya", "Uganda"]);
  });

  it("duplicate-seeded picker adds a country with keyboard and counter follows", async () => {
    await renderForm({ topics: base, countries: ["Kenya", "Kenya"] });
    expect(await searchAndEnter(countriesInput()!, "Ghana")).toBe(true);
    expect(fieldValues("countries")).toEqual(["Kenya", "Ghana"]);
    expect(counter()).toBe("5 of 10");
    expect(dupWarnings()).toHaveLength(0);
  });

  it("removing the deduped country removes it entirely (no ghost duplicate)", async () => {
    await renderForm({ topics: base, countries: ["Kenya", "Kenya", "Morocco"] });
    await removeChip("Kenya");
    expect(fieldValues("countries")).toEqual(["Morocco"]);
    expect(counter()).toBe("4 of 10");
    expect(document.querySelectorAll('[aria-label="Remove Kenya"]')).toHaveLength(0);
  });

  it("Backspace on a duplicate-seeded picker removes the last distinct country", async () => {
    await renderForm({ topics: base, countries: ["Kenya", "Kenya"] });
    const input = countriesInput()!;
    await act(async () => input.focus());
    await key(input, "Backspace");
    expect(fieldValues("countries")).toEqual([]);
    expect(fieldValues("topics")).toContain(COUNTRIES_TOPIC);
    expect(counter()).toBe("3 of 10");
  });

  it("duplicates without the Countries topic are still dropped", async () => {
    await renderForm({ topics: topicsList.slice(0, 3), countries: ["Kenya", "Kenya"] });
    expect(countriesInput()).toBeNull();
    expect(fieldValues("countries")).toEqual([]);
  });
});
