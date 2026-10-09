// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS } from "@/types";
import type { PreferencesState } from "@/lib/profileErrors";

// The stepped onboarding form as a new reader uses it: four steps in one
// <form>, a section index, the 3-unit check on Next, Enter that never submits
// or advances, saving only from Review, the review summary with its Edit
// links, and the header.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("@/app/auth/actions", () => ({ signOutAction: mocks.signOut }));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PRODUCT_NAME } = await import("@/config/brand");
const { TOPIC_GROUPS } = await import("@/config/topicGroups");
const { PROFILE_ERROR_MESSAGES } = await import("@/lib/profileErrors");
const { OnboardingView } = await import("@/components/onboarding/OnboardingView");
const { chip, clickChip, isPicked, topicSearch } = await import("@/components/__tests__/topicGridKit");

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
const headingOf = (index: number) => sections()[index].querySelector("h2")!;
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

describe("the steps", () => {
  it("are four sections of one form, all mounted, with only Topics showing", () => {
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(sections()).toHaveLength(4);
    expect(sections().map((s) => s.hidden)).toEqual([false, true, true, true]);
    expect(document.getElementById("preferences-countries")).not.toBeNull();
    expect(document.getElementById("preferences-sources")).not.toBeNull();
  });

  it("draw a section index with the current step in ink and unreached steps as plain text", () => {
    expect(indexItems().map((li) => li.textContent!.replace(/^—/, "").trim())).toEqual([
      "A · Topics",
      "B · Countries",
      "C · Outlets",
      "D · Review",
    ]);
    expect(container.querySelector('[aria-current="step"]')!.textContent).toBe("A · Topics");
    for (const li of indexItems().slice(1)) expect(li.querySelector("button")).toBeNull();
  });

  it("won't leave Topics below the minimum, and says why", async () => {
    await pickTopics(2);
    await press("Next: Countries");
    expect(shownStep()).toBe(0);
    expect(alertText()).toBe("Pick at least 1 more topic to continue. Each country counts as one.");

    await clickChip(plain[2]);
    expect(alertText()).toBeNull();
    await press("Next: Countries");
    expect(shownStep()).toBe(1);
  });

  it("move focus to the new step's heading, but not on first load", async () => {
    expect(document.activeElement).toBe(document.body);
    await pickTopics(3);
    await press("Next: Countries");
    expect(document.activeElement).toBe(headingOf(1));
    await press("Back");
    expect(document.activeElement).toBe(headingOf(0));
  });

  it("let Countries and Outlets be skipped, and say Next once something is picked", async () => {
    await pickTopics(3);
    await press("Next: Countries");
    expect(button("Skip")).toBeDefined();
    await pickFromDropdown("preferences-countries", "Morocco");
    expect(button("Skip")).toBeUndefined();
    await press("Next: Outlets");
    expect(shownStep()).toBe(2);
    await press("Skip");
    expect(shownStep()).toBe(3);
  });

  it("let the index jump back to any step already reached", async () => {
    await pickTopics(3);
    await press("Next: Countries");
    await press("Skip");
    await press("Skip");
    expect(shownStep()).toBe(3);
    for (const li of indexItems().slice(0, 3)) expect(li.querySelector("button")).not.toBeNull();

    await press("B · Countries");
    expect(shownStep()).toBe(1);
    expect(container.querySelector('[aria-current="step"]')!.textContent).toBe("B · Countries");
    // Review stays reachable from the index once reached.
    await press("D · Review");
    expect(shownStep()).toBe(3);
  });

  it("put the step in the header", async () => {
    expect(container.querySelector("header")!.textContent).toContain(PRODUCT_NAME);
    expect(container.querySelector("header")!.textContent).toContain("Step 1 of 4");
    await pickTopics(3);
    await press("Next: Countries");
    expect(container.querySelector("header")!.textContent).toContain("Step 2 of 4");
  });
});

describe("saving", () => {
  it("submits every pick from the Review step, though the other steps are hidden", async () => {
    await pickTopics(3);
    await press("Next: Countries");
    await pickFromDropdown("preferences-countries", "Morocco");
    await press("Next: Outlets");
    await pickFromDropdown("preferences-sources", SOURCES[2]);
    await press("Next: Review");

    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();
    expect(action).toHaveBeenCalledTimes(1);
    const sent = action.mock.calls[0][1];
    expect(sent.getAll("topics")).toEqual(plain.slice(0, 3));
    expect(sent.getAll("countries")).toEqual(["Morocco"]);
    expect(sent.getAll("preferredSources")).toEqual([SOURCES[2]]);
  });

  it("drops a submit from any step but Review", async () => {
    await pickTopics(3);
    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();
    await press("Next: Countries");
    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();
    expect(action).not.toHaveBeenCalled();
  });

  it("never submits or advances on Enter in a search box or dropdown", async () => {
    await pickTopics(3);
    expect(await key(topicSearch(), "Enter")).toBe(true);
    expect(shownStep()).toBe(0);
    await press("Next: Countries");
    const countries = document.getElementById("preferences-countries") as HTMLInputElement;
    await act(async () => countries.focus());
    expect(await key(countries, "Enter")).toBe(true);
    expect(shownStep()).toBe(1);
    expect(action).not.toHaveBeenCalled();
  });

  it("disables Save on Review below the minimum, with the reason beside it", async () => {
    await pickTopics(3);
    await press("Next: Countries");
    await press("Skip");
    await press("Skip");
    const save = () => button("Save and continue")!;
    expect(save().disabled).toBe(false);

    await press("A · Topics");
    await clickChip(plain[0]);
    await press("D · Review");
    expect(save().disabled).toBe(true);
    expect(document.getElementById(save().getAttribute("aria-describedby")!)!.textContent).toBe(
      "Pick at least 1 more topic to save. Each country counts as one."
    );
    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();
    expect(action).not.toHaveBeenCalled();
  });

  it("shows a refused save's message on Review and keeps every pick", async () => {
    action.mockResolvedValue({ error: "save_failed" });
    await pickTopics(3);
    await press("Next: Countries");
    await pickFromDropdown("preferences-countries", "Kenya");
    await press("Next: Outlets");
    await press("Skip");
    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();

    expect(alertText()).toBe(PROFILE_ERROR_MESSAGES.save_failed);
    expect(shownStep()).toBe(3);
    expect(fieldValues("topics")).toEqual(plain.slice(0, 3));
    expect(fieldValues("countries")).toEqual(["Kenya"]);
    expect(plain.slice(0, 3).every(isPicked)).toBe(true);
  });
});

describe("the review step", () => {
  async function toReview() {
    await press("Next: Countries");
    await press(button("Skip") ? "Skip" : "Next: Outlets");
    await press(button("Skip") ? "Skip" : "Next: Review");
  }

  it("reads the picks back, grouped, with the unit count", async () => {
    const [a, b] = [TOPIC_GROUPS[0].topics[0], TOPIC_GROUPS[3].topics[1]];
    await clickChip(a);
    await clickChip(b);
    await clickChip(TOPIC_GROUPS[0].topics[2]);
    await press("Next: Countries");
    await pickFromDropdown("preferences-countries", "Morocco");
    await pickFromDropdown("preferences-countries", "Kenya");
    await press("Next: Outlets");
    await press("Skip");

    const review = sections()[3];
    expect(review.querySelector("h2")!.textContent).toBe("Your edition will read…");
    expect(review.querySelector('[data-testid="review-units"]')!.textContent).toBe(
      "3 topics and 2 countries · 5 of 10"
    );
    const rows = [...review.querySelectorAll("dl > div")];
    expect(rows.map((r) => r.querySelector("dt")!.textContent)).toEqual(["Topics", "Countries", "Outlets"]);
    expect([...rows[0].querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      `${TOPIC_GROUPS[0].name}: ${a}, ${TOPIC_GROUPS[0].topics[2]}`,
      `${TOPIC_GROUPS[3].name}: ${b}`,
    ]);
    expect(rows[1].textContent).toContain("Morocco, Kenya");
    expect(rows[2].textContent).toContain("Every outlet for your topics");
  });

  it("has an Edit link per line, back to its step", async () => {
    await pickTopics(3);
    await toReview();
    const edits = [...sections()[3].querySelectorAll("dl button")];
    expect(edits.map((e) => e.textContent)).toEqual(["Edit topics", "Edit countries", "Edit outlets"]);

    await act(async () => (edits[1] as HTMLButtonElement).click());
    expect(shownStep()).toBe(1);
    expect(document.activeElement).toBe(headingOf(1));
  });

  it("names the outlets picked", async () => {
    await pickTopics(3);
    await press("Next: Countries");
    await press("Skip");
    await pickFromDropdown("preferences-sources", SOURCES[0]);
    await pickFromDropdown("preferences-sources", SOURCES[4]);
    await press("Next: Review");
    expect([...sections()[3].querySelectorAll("dl > div")][2].textContent).toContain(`${SOURCES[0]}, ${SOURCES[4]}`);
  });
});

describe("the topics step", () => {
  it("offers no starter sets", () => {
    expect(document.body.textContent).not.toContain("Start from a set");
  });
});

describe("the header's Sign out", () => {
  it("asks first, with the same confirmation as the newspaper menu", async () => {
    await press("Sign out");
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Sign out?");
    expect(dialog!.textContent).toContain("You'll need to sign in again to read your digest.");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});

it("never shows Countries as a chip", () => {
  expect(chip(COUNTRIES_TOPIC)).toBeUndefined();
});
