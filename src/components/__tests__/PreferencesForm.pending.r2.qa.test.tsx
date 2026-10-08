// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS } from "@/types";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { PreferencesForm } from "@/components/PreferencesForm";
import { PROFILE_ERROR_MESSAGES, type PreferencesState } from "@/lib/profileErrors";

// The refusal alert and the saved message while a save is pending,
// and codes the form doesn't know.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

// React entangles every pending async action, so a test that fails while a
// deferred save is unresolved would stall the next tests' updates. Settle
// whatever is left before unmounting.
const leftovers: Array<(s: PreferencesState | void) => void> = [];

afterEach(async () => {
  await act(async () => leftovers.splice(0).forEach((resolve) => resolve(undefined)));
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const plainTopics = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);
const SAVED = "Preferences saved.";

type Action = (previous: PreferencesState | void, formData: FormData) => Promise<PreferencesState | void>;

async function renderForm(action: Action, savedMessage?: string) {
  await act(async () => {
    root.render(
      <PreferencesForm
        action={action}
        defaultTopics={plainTopics.slice(0, 2)}
        defaultCountries={["Morocco"]}
        defaultSources={[SOURCES[0]]}
        submitLabel="Save"
        savedMessage={savedMessage}
      />
    );
  });
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const alertEl = () => container.querySelector('[role="alert"]');
const statusEl = () => container.querySelector('[role="status"]');
const submitButton = () => container.querySelector<HTMLButtonElement>("button[type=submit]")!;
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);
const picks = () => ({
  topics: fieldValues("topics"),
  countries: fieldValues("countries"),
  preferredSources: fieldValues("preferredSources"),
});

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
}

/** A controllable action: each call waits for the next settle(). */
function deferredAction() {
  const pending: Array<(s: PreferencesState | void) => void> = [];
  const calls: FormData[] = [];
  const action: Action = (_prev, fd) => {
    calls.push(fd);
    return new Promise((resolve) => {
      pending.push(resolve);
      leftovers.push(resolve);
    });
  };
  return {
    action,
    calls,
    settle: async (s: PreferencesState | void) => {
      const next = pending.shift();
      if (!next) throw new Error("no pending call");
      await act(async () => next(s));
      await flush();
    },
  };
}

/** Records every role=alert element added to or removed from the container. */
function watchAlerts() {
  const log: string[] = [];
  const isAlert = (n: Node) => n instanceof Element && n.getAttribute("role") === "alert";
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      r.removedNodes.forEach((n) => isAlert(n) && log.push("removed"));
      r.addedNodes.forEach((n) => isAlert(n) && log.push("added"));
    }
  });
  obs.observe(container, { childList: true, subtree: true });
  return { log, stop: () => obs.disconnect() };
}

describe("alert during a pending retry", () => {
  it("a fast-settling action still removes and re-inserts the alert for an identical refusal", async () => {
    await renderForm(async () => ({ error: "too_few" }));
    await submit();
    const first = alertEl();
    expect(first?.textContent).toBe(PROFILE_ERROR_MESSAGES.too_few);

    const w = watchAlerts();
    await submit();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    w.stop();

    expect(w.log).toEqual(["removed", "added"]);
    expect(alertEl()).not.toBe(first);
    expect(alertEl()?.textContent).toBe(PROFILE_ERROR_MESSAGES.too_few);
  });

  it("three identical refusals in a row give three distinct alert elements", async () => {
    await renderForm(async () => ({ error: "save_failed" }));
    const seen = new Set<Element>();
    for (let i = 0; i < 3; i++) {
      await submit();
      seen.add(alertEl()!);
    }
    expect(seen.size).toBe(3);
  });

  it("two submits queued while pending: no alert flashes between them, one alert at the end", async () => {
    const d = deferredAction();
    await renderForm(d.action, SAVED);

    await act(async () => container.querySelector("form")!.requestSubmit());
    // requestSubmit() with no submitter bypasses the disabled button, like a second Enter would.
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(submitButton().disabled).toBe(true);

    const w = watchAlerts();
    await d.settle({ error: "too_few" });
    // The second save is still queued, so the form is still pending.
    expect(alertEl()).toBeNull();
    expect(statusEl()).toBeNull();
    expect(submitButton().disabled).toBe(true);

    await d.settle({ error: "too_many" });
    w.stop();
    expect(alertEl()?.textContent).toBe(PROFILE_ERROR_MESSAGES.too_many);
    expect(w.log).toEqual(["added"]);
    expect(d.calls).toHaveLength(2);
    expect(submitButton().disabled).toBe(false);
  });

  it("keeps every pick and the same picker inputs across pending and two refusals", async () => {
    const d = deferredAction();
    await renderForm(d.action);
    const before = picks();
    const topicInput = document.getElementById("preferences-topics");

    for (let i = 0; i < 2; i++) {
      await act(async () => container.querySelector("form")!.requestSubmit());
      expect(picks()).toEqual(before);
      await d.settle({ error: "too_few" });
      expect(picks()).toEqual(before);
    }
    expect(document.getElementById("preferences-topics")).toBe(topicInput);
    expect(d.calls.map((f) => f.getAll("countries"))).toEqual([["Morocco"], ["Morocco"]]);
    expect(document.getElementById("preferences-topics-count")!.textContent).toBe("3 of 10");
  });
});

describe("saved message", () => {
  it("shows on a fresh render with savedMessage and no error, as a status", async () => {
    await renderForm(async () => ({ error: null }), SAVED);
    expect(statusEl()?.textContent).toBe(SAVED);
    expect(alertEl()).toBeNull();
  });

  it("is absent on a fresh render without savedMessage", async () => {
    await renderForm(async () => ({ error: null }));
    expect(statusEl()).toBeNull();
  });

  it("hides while the first save is pending, and comes back after one with no error", async () => {
    const d = deferredAction();
    await renderForm(d.action, SAVED);
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(statusEl()).toBeNull();
    await d.settle({ error: null });
    expect(statusEl()?.textContent).toBe(SAVED);
  });

  it("never flashes during a retry after a refusal (watched with a MutationObserver)", async () => {
    const d = deferredAction();
    await renderForm(d.action, SAVED);
    await act(async () => container.querySelector("form")!.requestSubmit());
    await d.settle({ error: "too_few" });
    expect(statusEl()).toBeNull();

    const added: string[] = [];
    const obs = new MutationObserver((rs) =>
      rs.forEach((r) =>
        r.addedNodes.forEach((n) => {
          if (n instanceof Element && n.getAttribute("role") === "status") added.push(n.textContent ?? "");
        })
      )
    );
    obs.observe(container, { childList: true, subtree: true });
    await act(async () => container.querySelector("form")!.requestSubmit());
    await d.settle({ error: "too_few" });
    obs.disconnect();
    expect(added).toEqual([]);
    expect(statusEl()).toBeNull();
  });

  it("an action returning nothing after a refusal shows the saved message again", async () => {
    const d = deferredAction();
    await renderForm(d.action, SAVED);
    await act(async () => container.querySelector("form")!.requestSubmit());
    await d.settle({ error: "too_few" });
    await act(async () => container.querySelector("form")!.requestSubmit());
    await d.settle(undefined);
    expect(alertEl()).toBeNull();
    expect(statusEl()?.textContent).toBe(SAVED);
  });
});

describe("codes the form doesn't know", () => {
  const unknown: unknown[] = [
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "TOO_FEW",
    "too_few ",
    42,
    {},
    ["too_few"],
    true,
  ];

  it.each(unknown.map((c) => [JSON.stringify(c), c]))(
    "%s shows no alert, renders without throwing, and hides the saved message",
    async (_label, code) => {
      await renderForm(async () => ({ error: code }) as unknown as PreferencesState, SAVED);
      await submit();
      expect(alertEl()).toBeNull();
      for (const m of Object.values(PROFILE_ERROR_MESSAGES)) expect(container.textContent).not.toContain(m);
      expect(statusEl()).toBeNull();
      expect(container.querySelector("form")).not.toBeNull();
    }
  );

  it("a real __proto__ own key from JSON is still unknown", async () => {
    const state = JSON.parse('{"error":"__proto__"}');
    await renderForm(async () => state, SAVED);
    await submit();
    expect(alertEl()).toBeNull();
  });

  it("an unknown code after a known refusal removes the old alert", async () => {
    const d = deferredAction();
    await renderForm(d.action);
    await act(async () => container.querySelector("form")!.requestSubmit());
    await d.settle({ error: "too_many" });
    expect(alertEl()?.textContent).toBe(PROFILE_ERROR_MESSAGES.too_many);
    await act(async () => container.querySelector("form")!.requestSubmit());
    await d.settle({ error: "constructor" } as unknown as PreferencesState);
    expect(alertEl()).toBeNull();
    expect(submitButton().disabled).toBe(false);
  });

  it("an empty-string code is no error: no alert, saved message shown", async () => {
    await renderForm(async () => ({ error: "" }) as unknown as PreferencesState, SAVED);
    await submit();
    expect(alertEl()).toBeNull();
    expect(statusEl()?.textContent).toBe(SAVED);
  });
});
