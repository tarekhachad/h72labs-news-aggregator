// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { MAX_TOPICS } from "@/lib/profile";
import { PreferencesForm } from "@/components/PreferencesForm";

// The Escape guard and the "Enter only adds" guard in MultiSelect's
// handleValueChange. Every legitimate removal path must still work, and no
// path may silently clear or drop picks. Names come from TOPICS/SOURCES by
// position or are computed. Real clock only (no fake timers).

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

function form(defaults: { topics?: Topic[]; sources?: Source[] } = {}) {
  return (
    <PreferencesForm
      action={async () => {}}
      defaultTopics={defaults.topics}
      defaultSources={defaults.sources}
      submitLabel="Save"
    />
  );
}

async function renderForm(defaults: { topics?: Topic[]; sources?: Source[] } = {}) {
  await act(async () => root.render(form(defaults)));
}

const topicsInput = () => document.getElementById("preferences-topics") as HTMLInputElement;
const sourcesInput = () => document.getElementById("preferences-sources") as HTMLInputElement;
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
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

const options = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const option = (label: string) => options().find((o) => o.textContent === label);
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);
const chipsOf = (input: HTMLInputElement) =>
  [...input.closest('[data-slot="combobox-chips"]')!.querySelectorAll<HTMLElement>('[data-slot="combobox-chip"]')];
const removeButton = (input: HTMLInputElement, label: string) =>
  chipsOf(input)
    .find((c) => c.textContent === label)!
    .querySelector<HTMLElement>('[data-slot="combobox-chip-remove"]')!;
const trimNotice = () =>
  [...container.querySelectorAll('p[role="status"]')].some((p) => p.textContent?.includes("limit is now"));

async function clickWith(el: HTMLElement, Ctor: typeof MouseEvent) {
  await act(async () => {
    el.dispatchEvent(new Ctor("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}

// A topic contained in another topic's name: searching it lists several
// matches, the first of which is computed.
function multiMatch() {
  const query = TOPICS.find((a) => TOPICS.some((b) => b !== a && b.includes(a)))!;
  expect(query).toBeDefined();
  const matches = TOPICS.filter((t) => t.toLowerCase().includes(query.toLowerCase()));
  expect(matches.length).toBeGreaterThan(1);
  return { query, matches };
}

describe("legitimate removals are not blocked by the Enter guard", () => {
  it("chip remove button activated by Enter removes that pick", async () => {
    const start = TOPICS.slice(0, 4);
    await renderForm({ topics: start });
    const input = topicsInput();
    await key(removeButton(input, start[1]), "Enter");
    expect(fieldValues("topics")).toEqual([start[0], start[2], start[3]]);
  });

  it("chip remove button activated by Space removes that pick", async () => {
    const start = TOPICS.slice(0, 4);
    await renderForm({ topics: start });
    const input = topicsInput();
    await key(removeButton(input, start[2]), " ");
    expect(fieldValues("topics")).toEqual([start[0], start[1], start[3]]);
  });

  it("chip remove button clicked with the mouse removes that pick (sources too)", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3), sources: SOURCES.slice(0, 3) });
    await clickWith(removeButton(sourcesInput(), SOURCES[0]), MouseEvent);
    expect(fieldValues("preferredSources")).toEqual(SOURCES.slice(1, 3));
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, 3));
  });

  it("a focused chip removes on Backspace and on Delete", async () => {
    const start = TOPICS.slice(0, 5);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());

    await key(input, "ArrowLeft");
    let chip = document.activeElement as HTMLElement;
    expect(chip.getAttribute("data-slot")).toBe("combobox-chip");
    expect(chip.textContent).toBe(start[4]);
    await key(chip, "Backspace");
    expect(fieldValues("topics")).toEqual(start.slice(0, 4));

    chip = document.activeElement as HTMLElement;
    expect(chip.getAttribute("data-slot")).toBe("combobox-chip");
    await key(chip, "Delete");
    expect(fieldValues("topics")).toHaveLength(3);
  });

  it("Backspace in an empty search box removes the last pick", async () => {
    const start = TOPICS.slice(0, 4);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await key(input, "Backspace");
    expect(fieldValues("topics")).toEqual(start.slice(0, 3));
  });

  it("a mouse click on a picked row removes it", async () => {
    const start = TOPICS.slice(0, 4);
    await renderForm({ topics: start });
    await open(topicsInput());
    await clickWith(option(start[2])!, MouseEvent);
    expect(fieldValues("topics")).toEqual([start[0], start[1], start[3]]);
  });

  it("a pointer-initiated click (PointerEvent) on a picked row removes it", async () => {
    const start = TOPICS.slice(0, 4);
    await renderForm({ topics: start });
    await open(topicsInput());
    expect(typeof PointerEvent).toBe("function");
    await clickWith(option(start[0])!, PointerEvent as unknown as typeof MouseEvent);
    expect(fieldValues("topics")).toEqual(start.slice(1));
  });

  it("after a blocked Enter, the next mouse click on the same picked row still removes it", async () => {
    const { query, matches } = multiMatch();
    const other = TOPICS.find((t) => !matches.includes(t))!;
    const start = [other, matches[0], TOPICS.find((t) => t !== other && !matches.includes(t))!];
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, query);
    expect(options()[0]!.textContent).toBe(matches[0]);

    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(start);

    await open(input);
    await clickWith(option(matches[0])!, MouseEvent);
    expect(fieldValues("topics")).toEqual([start[0], start[2]]);
  });

  it("after Enter on a disabled match at the limit, a click on a picked row still removes it", async () => {
    const { query, matches } = multiMatch();
    const picked = [...matches.slice(1), ...TOPICS.filter((t) => !matches.includes(t))].slice(
      0,
      MAX_TOPICS
    ) as Topic[];
    await renderForm({ topics: picked });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, query);
    expect(options()[0]!.getAttribute("aria-disabled")).toBe("true");
    await key(input, "Enter");
    expect(fieldValues("topics")).toEqual(picked);

    await clickWith(option(matches[1])!, MouseEvent);
    expect(fieldValues("topics")).toEqual(picked.filter((t) => t !== matches[1]));
  });
});

describe("Enter only adds", () => {
  it("Enter on an unpicked first match still adds it", async () => {
    const start = TOPICS.slice(0, 3);
    const target = TOPICS[TOPICS.length - 2];
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, target);
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual([...start, target]);
  });

  it("Enter on a picked match keeps it, closes the list, doesn't submit; the box is then ready", async () => {
    const { query, matches } = multiMatch();
    const others = TOPICS.filter((t) => !matches.includes(t));
    const start = [others[0], matches[0], others[1]];
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, query);

    expect(await key(input, "Enter")).toBe(true); // not submitted
    expect(fieldValues("topics")).toEqual(start);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("");
    // The list is closed and the box empty, so a follow-up Enter is left to submit.
    expect(await key(input, "Enter")).toBe(false);
    expect(fieldValues("topics")).toEqual(start);
  });

  it("Enter on a picked row reached with ArrowDown in an empty box keeps it and doesn't submit", async () => {
    const start = TOPICS.slice(2, 6);
    await renderForm({ topics: start });
    const input = topicsInput();
    await open(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(start);
  });

  it("Enter on a picked source match keeps it (no max on sources)", async () => {
    const start = SOURCES.slice(0, 3);
    await renderForm({ topics: TOPICS.slice(0, 3), sources: start });
    const input = sourcesInput();
    await act(async () => input.focus());
    await type(input, start[1]);
    expect(options()[0]!.textContent).toBe(start[1]);
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("preferredSources")).toEqual(start);
  });

  it("over the limit, Enter on a picked match keeps every pick and the trim notice; the × still trims", async () => {
    const saved = TOPICS.slice(0, MAX_TOPICS + 1);
    await renderForm({ topics: saved });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, saved[3]);
    expect(options()[0]!.textContent).toBe(saved[3]);
    expect(options()[0]!.getAttribute("aria-disabled")).toBeNull();

    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues("topics")).toEqual(saved);
    expect(trimNotice()).toBe(true);

    await key(removeButton(input, saved[3]), "Enter");
    expect(fieldValues("topics")).toEqual(saved.filter((t) => t !== saved[3]));
    expect(trimNotice()).toBe(false);
  });
});

describe("no path silently clears or drops picks", () => {
  it("Escape in a closed list with whitespace-only text clears the text, keeps picks", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, "   ");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    await key(input, "Escape");
    expect(input.value).toBe("");
    expect(fieldValues("topics")).toEqual(start);
  });

  it("Escape in an open list with search text closes it, clears text, keeps picks; repeated Escapes too", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start, sources: SOURCES.slice(0, 2) });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, TOPICS[TOPICS.length - 1]);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await key(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("");
    for (let i = 0; i < 3; i++) await key(input, "Escape");
    expect(fieldValues("topics")).toEqual(start);
    expect(fieldValues("preferredSources")).toEqual(SOURCES.slice(0, 2));
  });

  it("Escape on a focused chip keeps picks", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await key(input, "ArrowLeft");
    await key(document.activeElement!, "Escape");
    await key(input, "Escape");
    expect(fieldValues("topics")).toEqual(start);
  });

  it("Escape on a closed, empty box with picks keeps them, in both pickers", async () => {
    await renderForm({ topics: TOPICS.slice(0, 3), sources: SOURCES.slice(0, 2) });
    for (const input of [topicsInput(), sourcesInput()]) {
      await act(async () => input.focus());
      expect(input.getAttribute("aria-expanded")).toBe("false");
      await key(input, "Escape");
    }
    expect(fieldValues("topics")).toEqual(TOPICS.slice(0, 3));
    expect(fieldValues("preferredSources")).toEqual(SOURCES.slice(0, 2));
  });

  it("blur and focus moving away with an open search keep picks", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start, sources: [SOURCES[0]] });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, TOPICS[TOPICS.length - 1]);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await key(input, "Tab");
    await act(async () => sourcesInput().focus());
    await flush();
    await act(async () => input.blur());
    await flush();
    expect(fieldValues("topics")).toEqual(start);
    expect(fieldValues("preferredSources")).toEqual([SOURCES[0]]);
  });

  it("an outside press with an open list keeps picks", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start });
    const input = topicsInput();
    await open(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(fieldValues("topics")).toEqual(start);
  });

  it("a re-render with new defaults keeps the reader's in-progress picks", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, TOPICS[TOPICS.length - 1]);
    await key(input, "Enter");
    const current = [...start, TOPICS[TOPICS.length - 1]];
    expect(fieldValues("topics")).toEqual(current);

    await act(async () => root.render(form({ topics: TOPICS.slice(5, 8), sources: [SOURCES[1]] })));
    await flush();
    expect(fieldValues("topics")).toEqual(current);
    expect(fieldValues("preferredSources")).toEqual([]);
  });

  it("modifier+Enter on a picked match neither removes nor submits", async () => {
    const start = TOPICS.slice(0, 3);
    await renderForm({ topics: start });
    const input = topicsInput();
    await act(async () => input.focus());
    await type(input, start[1]);
    for (const mod of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(await key(input, "Enter", mod)).toBe(true);
      expect(fieldValues("topics")).toEqual(start);
    }
  });
});
