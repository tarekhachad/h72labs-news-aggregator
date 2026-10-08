// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS, type Topic } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";
import { PreferencesForm } from "@/components/PreferencesForm";
import { PROFILE_ERROR_MESSAGES, type PreferencesState } from "@/lib/profileErrors";

// The useActionState form with the keyboard rules, the counter and the
// country flags all in play together: keyboard picks survive a refusal,
// Enter while searching never submits, Escape never clears, Enter never
// removes, and the search and screen-reader text ignore the flags.

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
type Action = (previous: PreferencesState | void, formData: FormData) => Promise<PreferencesState | void>;

async function renderForm(action: Action, topicCount = 2, countries: string[] = [], savedMessage?: string) {
  const defaultTopics: Topic[] = plain.slice(0, topicCount);
  if (countries.length > 0) defaultTopics.push(COUNTRIES_TOPIC);
  await act(async () => {
    root.render(
      <PreferencesForm
        action={action}
        defaultTopics={defaultTopics}
        defaultCountries={countries}
        defaultSources={[SOURCES[0]]}
        submitLabel="Save"
        savedMessage={savedMessage}
      />
    );
  });
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const topicsInput = () => document.getElementById("preferences-topics") as HTMLInputElement;
const countriesInput = () => document.getElementById("preferences-countries") as HTMLInputElement;
const counter = () => document.getElementById("preferences-topics-count")!.textContent;
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);
const picks = () => ({
  topics: fieldValues("topics"),
  countries: fieldValues("countries"),
  preferredSources: fieldValues("preferredSources"),
});

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
      new InputEvent("input", { bubbles: true, inputType: text === "" ? "deleteContentBackward" : "insertText", data: text })
    );
  });
  await flush();
}

async function focus(input: HTMLInputElement) {
  await act(async () => input.focus());
  await flush();
}

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
}

describe("refusal with keyboard picks (both pickers)", () => {
  it("keeps topics and countries picked by keyboard after a refusal, and the counter with them", async () => {
    const action = vi.fn<Action>(async () => ({ error: "too_many" }));
    await renderForm(action, 1);
    expect(counter()).toBe("Pick at least 2 more");

    await focus(topicsInput());
    await type(topicsInput(), plain[4].slice(0, 4));
    const topicTarget = options()[0].textContent!;
    expect(await key(topicsInput(), "Enter")).toBe(true);
    expect(counter()).toBe("Pick at least one more");

    await focus(countriesInput());
    await type(countriesInput(), "Mor");
    expect(options().map((o) => o.textContent)).toEqual(["Morocco"]);
    expect(await key(countriesInput(), "Enter")).toBe(true);
    expect(counter()).toBe("3 of 10");
    expect(action).not.toHaveBeenCalled();

    const before = picks();
    expect(before.topics).toEqual([plain[0], topicTarget]);
    expect(before.countries).toEqual(["Morocco"]);

    await submit();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0][1].getAll("countries")).toEqual(["Morocco"]);
    expect(picks()).toEqual(before);
    expect(counter()).toBe("3 of 10");
    expect(alertText()).toBe(PROFILE_ERROR_MESSAGES.too_many);

    // And the visible chips match the hidden inputs.
    const chipText = [...container.querySelectorAll('[data-slot="combobox-chip"]')].map((c) => c.textContent);
    expect(chipText).toEqual([plain[0], topicTarget, "Morocco", SOURCES[0]]);
  });

  it("a second, different refusal replaces the first message; a later empty return clears it", async () => {
    const results: (PreferencesState | void)[] = [{ error: "too_few" }, { error: "save_failed" }, undefined];
    await renderForm(async () => results.shift());
    await submit();
    expect(alertText()).toBe(PROFILE_ERROR_MESSAGES.too_few);
    await submit();
    expect(alertText()).toBe(PROFILE_ERROR_MESSAGES.save_failed);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    await submit();
    expect(alertText()).toBeNull();
  });

  it("puts the error inside the form, between the pickers and the submit button", async () => {
    await renderForm(async () => ({ error: "invalid" }));
    await submit();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.closest("form")).not.toBeNull();
    const button = container.querySelector("button[type=submit]")!;
    expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the saved message uses the foreground token and sits in the form", async () => {
    await renderForm(async () => undefined, 3, [], "Preferences saved.");
    const saved = container.querySelector('[role="status"]')!;
    expect(saved.textContent).toBe("Preferences saved.");
    expect(saved.closest("form")).not.toBeNull();
    expect(saved.getAttribute("style")).toContain("var(--color-foreground)");
    expect(container.innerHTML).not.toContain("#166534");
  });
});

describe("L8 keyboard rules inside the action form", () => {
  it.each([
    ["topics", () => topicsInput(), () => plain[5].slice(0, 5)],
    ["countries", () => countriesInput(), () => "Mor"],
  ])("%s: Enter while searching picks and never submits", async (_n, input, query) => {
    const action = vi.fn<Action>(async () => ({ error: "too_few" }));
    await renderForm(action, 2);
    await focus(input());
    await type(input(), query());
    const prevented = await key(input(), "Enter");
    expect(prevented).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(alertText()).toBeNull();
  });

  it.each([
    ["topics", () => topicsInput()],
    ["countries", () => countriesInput()],
  ])("%s: Enter on a search with no match is prevented and picks nothing", async (_n, input) => {
    const action = vi.fn<Action>(async () => ({ error: "too_few" }));
    await renderForm(action, 2, ["Morocco"]);
    const before = picks();
    await focus(input());
    await type(input(), "zzzz-no-match");
    expect(await key(input(), "Enter")).toBe(true);
    expect(picks()).toEqual(before);
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    ["topics", () => topicsInput()],
    ["countries", () => countriesInput()],
  ])("%s: Escape (open list, then closed list, twice) never clears picks", async (_n, input) => {
    await renderForm(async () => undefined, 3, ["Morocco", "Kenya"]);
    const before = picks();
    await focus(input());
    await key(input(), "ArrowDown");
    await key(input(), "Escape");
    await key(input(), "Escape");
    await key(input(), "Escape");
    expect(picks()).toEqual(before);
    expect(counter()).toBe("5 of 10");
  });

  it("countries: Enter on an already-picked highlighted country never removes it", async () => {
    await renderForm(async () => undefined, 2, ["Morocco"]);
    await focus(countriesInput());
    await type(countriesInput(), "Mor");
    expect(options()[0].textContent).toBe("Morocco");
    await key(countriesInput(), "Enter");
    expect(fieldValues("countries")).toEqual(["Morocco"]);
    expect(counter()).toBe("3 of 10");
  });

  it("topics: Enter on an already-picked highlighted topic never removes it", async () => {
    await renderForm(async () => undefined, 3);
    await focus(topicsInput());
    await type(topicsInput(), plain[0]);
    expect(options()[0].textContent).toBe(plain[0]);
    await key(topicsInput(), "Enter");
    expect(fieldValues("topics")).toEqual(plain.slice(0, 3));
  });
});

describe("counter wording, with and without countries", () => {
  it.each([
    [0, 0, "Pick at least 3"],
    [0, 1, "Pick at least 2 more"],
    [0, 2, "Pick at least one more"],
    [0, 3, "3 of 10"],
    [1, 1, "Pick at least one more"],
    [0, 10, "10 of 10"],
    [9, 1, "10 of 10"],
    [3, 0, "3 of 10"],
  ])("%i topics + %i countries → %s", async (t, c, text) => {
    await renderForm(async () => undefined, t, COUNTRIES.slice(0, c) as string[]);
    expect(counter()).toBe(text);
  });

  it("over the limit: the counter shows the count in red and the notice names the units", async () => {
    await renderForm(async () => undefined, 8, COUNTRIES.slice(0, 3) as string[]);
    const el = document.getElementById("preferences-topics-count")!;
    expect(el.textContent).toBe("11 of 10");
    expect(el.getAttribute("style")).toContain("var(--color-destructive)");
    expect(container.querySelector('p[role="status"]')!.textContent).toBe(
      "You follow 11 topics and countries; the limit is now 10. Remove 1 before you next save."
    );
  });

  it("below the minimum the counter stays muted, not red", async () => {
    await renderForm(async () => undefined, 1);
    expect(document.getElementById("preferences-topics-count")!.getAttribute("style")).toContain(
      "var(--color-muted-foreground)"
    );
  });

  it("updates live as a country chip is removed, crossing back below the minimum", async () => {
    await renderForm(async () => undefined, 2, ["Morocco"]);
    expect(counter()).toBe("3 of 10");
    await act(async () => (container.querySelector('[aria-label="Remove Morocco"]') as HTMLElement).click());
    await flush();
    expect(counter()).toBe("Pick at least one more");
    expect(fieldValues("countries")).toEqual([]);
  });
});

describe("flags", () => {
  it("every country row's accessible text is exactly its name", async () => {
    await renderForm(async () => undefined, 3);
    await focus(countriesInput());
    await key(countriesInput(), "ArrowDown");
    const rows = options();
    expect(rows).toHaveLength(COUNTRIES.length);
    for (const row of rows) {
      const svg = row.querySelector("svg[data-slot='country-flag']")!;
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.getAttribute("role")).toBeNull();
      expect(svg.getAttribute("aria-label")).toBeNull();
      expect(svg.querySelector("title, desc")).toBeNull();
      // Fixed box, so a flag can't change a row's height or push the name.
      expect(svg.getAttribute("class")).toContain("h-3");
      expect(svg.getAttribute("class")).toContain("w-[18px]");
      expect(svg.getAttribute("class")).toContain("shrink-0");
    }
  });

  it.each([
    ["Mor", ["Morocco"]],
    ["côte", ["Côte d'Ivoire"]],
    ["dr c", ["DR Congo"]],
    ["kong", ["Hong Kong"]],
  ])("searching %s finds %j", async (q, expected) => {
    await renderForm(async () => undefined, 3);
    await focus(countriesInput());
    await type(countriesInput(), q);
    expect(options().map((o) => o.textContent)).toEqual(expected);
  });

  it("the chip's remove button is still named by the country alone", async () => {
    await renderForm(async () => undefined, 2, ["Côte d'Ivoire"]);
    expect(container.querySelector(`[aria-label="Remove Côte d'Ivoire"]`)).not.toBeNull();
    const chip = [...container.querySelectorAll('[data-slot="combobox-chip"]')].find((c) =>
      c.textContent?.includes("Côte")
    )!;
    expect(chip.textContent).toBe("Côte d'Ivoire");
  });
});
