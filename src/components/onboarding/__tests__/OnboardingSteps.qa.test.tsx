// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS } from "@/types";
import type { PreferencesState } from "@/lib/profileErrors";

// The stepped onboarding form as a new reader uses it: three steps in one
// <form>, a section index, the 3-unit check on Next, Enter that never submits
// or advances, saving only from Review, the review summary with its Edit
// links, and the header.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("@/app/auth/actions", () => ({ signOutAction: mocks.signOut }));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { OnboardingView } = await import("@/components/onboarding/OnboardingView");
const { AT_LIMIT, chip, clickChip, isPicked, topicSearch } = await import("@/components/__tests__/topicGridKit");

type Action = (previous: PreferencesState | void, formData: FormData) => Promise<PreferencesState | void>;

const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);

let container: HTMLDivElement;
let root: Root;
let action: ReturnType<typeof vi.fn<Action>>;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  action = vi.fn<Action>(async () => undefined);
  await act(async () => root.render(<OnboardingView action={action} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function key(target: Element, k: string) {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await flush();
  return event.defaultPrevented;
}

/** Buttons a reader can see: none inside a hidden step. */
const buttons = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.closest("[hidden]") === null);
const button = (name: string) => buttons().find((b) => b.textContent === name);

async function press(name: string) {
  const target = button(name);
  if (target === undefined) throw new Error(`no button ${name}`);
  await act(async () => target.click());
  await flush();
}

const sections = () => [...container.querySelectorAll<HTMLElement>("form > section")];
const shownStep = () => sections().findIndex((s) => !s.hidden);
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);
const indexItems = () => [...container.querySelectorAll('nav[aria-label="Setup steps"] li')];
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

async function pickFromDropdown(id: string, label: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  const option = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  )!;
  await act(async () => option.click());
  await flush();
  await key(input, "Escape");
}

async function pickTopics(n: number) {
  for (const topic of plain.slice(0, n)) await clickChip(topic);
}


const countersText = () => ({
  grid: document.getElementById("preferences-topics-count")?.textContent ?? null,
  countries: document.getElementById("preferences-countries-count")?.textContent ?? null,
});

describe("round 1 qa: combined step", () => {
  it("has no Skip or Back on the first step, and the step count is exactly 3", () => {
    expect(button("Skip")).toBeUndefined();
    expect(button("Back")).toBeUndefined();
    expect(button("Next: Outlets")).toBeDefined();
    expect(container.querySelector("header")!.textContent).not.toContain("of 4");
    expect(indexItems()).toHaveLength(3);
  });

  it("0 topics + 3 countries continues (units, not topics, are counted)", async () => {
    for (const c of ["Morocco", "Kenya", "Ghana"]) await pickFromDropdown("preferences-countries", c);
    await press("Next: Outlets");
    expect(shownStep()).toBe(1);
  });

  it("2 topics + 0 countries is refused, then 1 country unblocks it", async () => {
    await pickTopics(2);
    await press("Next: Outlets");
    expect(shownStep()).toBe(0);
    await pickFromDropdown("preferences-countries", "Morocco");
    expect(alertText()).toBeNull();
    await press("Next: Outlets");
    expect(shownStep()).toBe(1);
  });

  it("shows one shared counter, the grid's, which the countries picker above it points at", async () => {
    await pickTopics(4);
    await pickFromDropdown("preferences-countries", "Morocco");
    await pickFromDropdown("preferences-countries", "Kenya");
    const c = countersText();
    expect(c.grid).toBe("6 of 10");
    expect(c.countries).toBeNull();
    const countries = document.getElementById("preferences-countries")!;
    expect(countries.getAttribute("aria-describedby")).toContain("preferences-topics-count");
    expect(container.querySelectorAll('[aria-live="polite"]').length).toBeGreaterThan(0);
  });

  it("puts the countries picker above the topic grid, so both are in view on first load", () => {
    const countries = document.getElementById("preferences-countries")!;
    const grid = document.getElementById("preferences-topics-count")!;
    expect(countries.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("at 10 units (8 topics + 2 countries) both pickers refuse more, and the shared counter says why", async () => {
    await pickTopics(8);
    await pickFromDropdown("preferences-countries", "Morocco");
    await pickFromDropdown("preferences-countries", "Kenya");
    expect(countersText().grid).toBe(AT_LIMIT);
    expect(countersText().countries).toBeNull();
    // an unpicked chip is blocked
    const extra = chip(plain[8])!;
    expect(extra.getAttribute("aria-disabled")).toBe("true");
    await clickChip(plain[8]);
    expect(isPicked(plain[8])).toBe(false);
    // and the countries dropdown offers no further country
    const input = document.getElementById("preferences-countries") as HTMLInputElement;
    await act(async () => input.focus());
    await key(input, "ArrowDown");
    const ghana = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
      (o) => o.textContent === "Ghana"
    )!;
    expect(ghana.hasAttribute("data-disabled") || ghana.getAttribute("aria-disabled") === "true").toBe(true);
    await act(async () => ghana.click());
    await flush();
    await key(input, "Escape");
    expect(fieldValues("countries")).toEqual(["Morocco", "Kenya"]);
  });

  it("at 10 units made mostly of countries, the grid blocks topics too", async () => {
    await pickTopics(3);
    for (const c of ["Morocco", "Kenya", "Ghana", "Egypt", "Nigeria", "Senegal", "Tunisia"])
      await pickFromDropdown("preferences-countries", c);
    expect(countersText().grid).toBe(AT_LIMIT);
    expect(chip(plain[5])!.getAttribute("aria-disabled")).toBe("true");
  });

  it("both Edit links for topics and countries land on the first step; Back from Outlets returns to it", async () => {
    await pickTopics(3);
    await press("Next: Outlets");
    await press("Back");
    expect(shownStep()).toBe(0);
    expect(container.querySelector("header")!.textContent).toContain("Step 1 of 3");
    await press("Next: Outlets");
    await press("Skip");
    expect(container.querySelector("header")!.textContent).toContain("Step 3 of 3");
    const edit = () => [...sections()[2].querySelectorAll<HTMLButtonElement>("dl button")];
    await act(async () => edit()[0].click());
    expect(shownStep()).toBe(0);
    await press("C · Review");
    await act(async () => edit()[1].click());
    expect(shownStep()).toBe(0);
  });

  it("the index does not jump to a step not yet reached", async () => {
    await pickTopics(3);
    expect(button("B · Outlets")).toBeUndefined();
    expect(button("C · Review")).toBeUndefined();
    await press("Next: Outlets");
    expect(button("C · Review")).toBeUndefined();
    expect(button("A · Topics & countries")).toBeDefined();
  });

  it("Back from Review lands on Outlets, and all picks submit from the hidden first step", async () => {
    await pickTopics(3);
    await pickFromDropdown("preferences-countries", "Morocco");
    await press("Next: Outlets");
    await press("Skip");
    await press("Back");
    expect(shownStep()).toBe(1);
    expect(sections()[0].hidden).toBe(true);
    expect(fieldValues("topics")).toHaveLength(3);
    expect(fieldValues("countries")).toEqual(["Morocco"]);
  });

  it("holds only Enter: other keys in the topic search keep their default action", async () => {
    expect(await key(topicSearch(), "a")).toBe(false);
  });
});
