// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { PreferencesForm } from "@/components/PreferencesForm";
import { clickChip } from "./topicGridKit";
import {
  PROFILE_ERROR_MESSAGES,
  type PreferencesState,
  type ProfileErrorCode,
} from "@/lib/profileErrors";

// A refused save returns a code instead of navigating. The reader's picks,
// including ones made after the page loaded, must survive it: React resets
// the form once the action settles, and the pickers' hidden inputs have to
// come through that reset unchanged.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

// Settled after each test, so one that fails before settling its action
// can't leave React's queued actions stuck for the tests after it.
let unsettled: Array<() => void> = [];

/** An action that stays pending until `settle` is called with its result. */
function deferredAction() {
  let resolve!: (state: PreferencesState) => void;
  const action = () =>
    new Promise<PreferencesState>((r) => {
      resolve = r;
      unsettled.push(() => r({ error: null }));
    });
  return { action, settle: (state: PreferencesState) => resolve(state) };
}

afterEach(async () => {
  await act(async () => unsettled.forEach((settle) => settle()));
  unsettled = [];
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const plainTopics = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);

type Action = (previous: PreferencesState | void, formData: FormData) => Promise<PreferencesState | void>;

async function renderForm(action: Action, savedMessage?: string) {
  await act(async () => {
    root.render(
      <PreferencesForm
        action={action}
        defaultTopics={plainTopics.slice(0, 3)}
        defaultSources={[SOURCES[0]]}
        submitLabel="Save"
        savedMessage={savedMessage}
      />
    );
  });
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function key(target: Element, k: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

const option = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === label
  );

async function pickWithClick(inputId: string, label: string) {
  const input = document.getElementById(inputId) as HTMLInputElement;
  await act(async () => input.focus());
  await key(input, "ArrowDown");
  await flush();
  await act(async () => option(label)!.click());
  await flush();
  await key(input, "Escape");
}

const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

const picks = () => ({
  topics: fieldValues("topics"),
  countries: fieldValues("countries"),
  preferredSources: fieldValues("preferredSources"),
});

const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;
const submitButton = () => container.querySelector<HTMLButtonElement>("button[type=submit]")!;

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
}

describe("PreferencesForm after a refused save", () => {
  it("keeps every pick, including ones made on the page, through React's form reset", async () => {
    const received: FormData[] = [];
    await renderForm(async (_previous, formData) => {
      received.push(formData);
      return { error: "too_many" };
    });

    await clickChip(plainTopics[5]);
    await pickWithClick("preferences-countries", "Morocco");
    await pickWithClick("preferences-sources", SOURCES[3]);
    const before = picks();
    expect(before).toEqual({
      topics: [...plainTopics.slice(0, 3), plainTopics[5]],
      countries: ["Morocco"],
      preferredSources: [SOURCES[0], SOURCES[3]],
    });

    let resets = 0;
    container.querySelector("form")!.addEventListener("reset", () => resets++);
    await submit();

    expect(received).toHaveLength(1);
    expect(received[0].getAll("countries")).toEqual(["Morocco"]);
    // Without the reset this test would prove nothing about surviving it.
    expect(resets).toBe(1);
    expect(picks()).toEqual(before);
    expect(alertText()).toBe(PROFILE_ERROR_MESSAGES.too_many);
    expect(document.getElementById("preferences-topics-count")!.textContent).toBe("5 of 10");
  });

  it("sends the same picks again on the next submit", async () => {
    const received: FormData[] = [];
    await renderForm(async (_previous, formData) => {
      received.push(formData);
      return { error: "save_failed" };
    });
    await submit();
    await submit();
    expect(received.map((f) => f.getAll("topics"))).toEqual([
      plainTopics.slice(0, 3),
      plainTopics.slice(0, 3),
    ]);
    expect(received.map((f) => f.getAll("preferredSources"))).toEqual([[SOURCES[0]], [SOURCES[0]]]);
  });

  it.each(Object.keys(PROFILE_ERROR_MESSAGES) as ProfileErrorCode[])(
    "shows %s's fixed message and nothing else",
    async (code) => {
      await renderForm(async () => ({ error: code }));
      await submit();
      expect(alertText()).toBe(PROFILE_ERROR_MESSAGES[code]);
    }
  );

  it("hides the saved message while a refusal is showing", async () => {
    await renderForm(async () => ({ error: "too_few" }), "Preferences saved.");
    expect(container.textContent).toContain("Preferences saved.");
    await submit();
    expect(container.textContent).not.toContain("Preferences saved.");
    expect(alertText()).toBe(PROFILE_ERROR_MESSAGES.too_few);
  });

  it("shows no message before any submit, and none for an action that returns nothing", async () => {
    await renderForm(async () => undefined);
    expect(alertText()).toBeNull();
    await submit();
    expect(alertText()).toBeNull();
  });

  it("removes the alert while a save is pending, so the same refusal again is a new alert", async () => {
    const { action, settle } = deferredAction();
    await renderForm(action);

    await act(async () => container.querySelector("form")!.requestSubmit());
    await act(async () => settle({ error: "too_few" }));
    await flush();
    const first = container.querySelector('[role="alert"]');
    expect(first?.textContent).toBe(PROFILE_ERROR_MESSAGES.too_few);

    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => settle({ error: "too_few" }));
    await flush();
    const second = container.querySelector('[role="alert"]');
    expect(second?.textContent).toBe(PROFILE_ERROR_MESSAGES.too_few);
    expect(second).not.toBe(first);
  });

  it("hides the last save's saved message while the next save is pending", async () => {
    const { action, settle } = deferredAction();
    await renderForm(action, "Preferences saved.");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Preferences saved.");

    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(container.textContent).not.toContain("Preferences saved.");

    await act(async () => settle({ error: "too_few" }));
    await flush();
    expect(container.textContent).not.toContain("Preferences saved.");
    expect(alertText()).toBe(PROFILE_ERROR_MESSAGES.too_few);
  });

  it("shows nothing for a code it doesn't know", async () => {
    await renderForm(async () => ({ error: "toString" }) as unknown as PreferencesState);
    await submit();
    expect(alertText()).toBeNull();
  });

  it("disables the submit button while the action is pending, and enables it after a refusal", async () => {
    const { action, settle } = deferredAction();
    await renderForm(action);

    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe("Saving…");

    await act(async () => settle({ error: "too_few" }));
    await flush();
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toBe("Save");
    expect(alertText()).toBe(PROFILE_ERROR_MESSAGES.too_few);
  });
});
