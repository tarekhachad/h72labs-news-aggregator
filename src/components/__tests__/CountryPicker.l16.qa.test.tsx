// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TOPICS, type Topic } from "@/types";

// QA (V2.7 L16): the always-shown countries picker, driven through the real
// form, and the full round trip getUserProfile -> form -> ProfileInput ->
// saveUserProfile against an in-memory fake of the preference tables.

vi.mock("@/config/countries", async (importActual) => ({
  ...(await importActual<typeof import("@/config/countries")>()),
  COUNTRIES: ["Kenya", "Morocco", "Nigeria", "Uganda", "Senegal", "Ghana", "Egypt", "Tanzania", "Mali", "Zambia", "Zimbabwe"],
}));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PreferencesForm } = await import("@/components/PreferencesForm");
const { ProfileInput, getUserProfile, saveUserProfile } = await import("@/lib/profile");
const { AT_LIMIT, chip, chipNames, chips, clickChip, searchTopics, topicSearch } = await import("./topicGridKit");

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

async function renderForm(
  defaults: { topics?: readonly Topic[]; countries?: readonly string[]; sources?: readonly string[] } = {}
) {
  await act(async () => {
    root.render(
      <PreferencesForm
        action={async (_previous, formData) => {
          submitted.push(formData);
        }}
        defaultTopics={defaults.topics && [...defaults.topics]}
        defaultCountries={defaults.countries && [...defaults.countries]}
        defaultSources={defaults.sources && ([...defaults.sources] as never)}
        submitLabel="Save"
      />
    );
  });
}

const countriesInput = () => document.getElementById("preferences-countries") as HTMLInputElement;
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
const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);
const counter = () => document.getElementById("preferences-topics-count")!.textContent;
const fieldValues = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value);

async function pickWithClick(input: HTMLInputElement, label: string) {
  await open(input);
  await act(async () => optionEl(label)!.click());
  await flush();
  await key(input, "Escape");
}

async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  return submitted.at(-1)!;
}

// --- L8 keyboard rules, on both pickers ------------------------------------

// The topics are a grid now, with its own keyboard rules below; the
// countries dropdown keeps L8's.
const pickers = [
  {
    name: "countries",
    input: countriesInput,
    defaults: { topics: [plain[0], plain[1], plain[2], COUNTRIES_TOPIC], countries: ["Kenya"] },
    picked: () => "Kenya",
    unpickedQuery: () => "Ugan",
    unpicked: () => "Uganda",
  },
] as const;

describe.each(pickers)("L8 keyboard rules on the $name picker", (p) => {
  it("Enter while searching picks the match and is default-prevented (no submit)", async () => {
    await renderForm(p.defaults);
    const before = fieldValues(p.name);
    const input = p.input();
    await act(async () => input.focus());
    await type(input, p.unpickedQuery());
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues(p.name)).toEqual([...before, p.unpicked()]);
    expect(submitted).toHaveLength(0);
  });

  it("Enter while searching with no match is default-prevented and picks nothing", async () => {
    await renderForm(p.defaults);
    const before = { topics: fieldValues("topics"), countries: fieldValues("countries") };
    const input = p.input();
    await act(async () => input.focus());
    await type(input, "zzzz-no-such-thing");
    expect(await key(input, "Enter")).toBe(true);
    expect({ topics: fieldValues("topics"), countries: fieldValues("countries") }).toEqual(before);
    expect(submitted).toHaveLength(0);
  });

  it("Enter on an already-picked highlighted item keeps it", async () => {
    await renderForm(p.defaults);
    const before = fieldValues(p.name);
    const input = p.input();
    await act(async () => input.focus());
    await type(input, p.picked());
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues(p.name)).toEqual(before);
    // And via ArrowDown in an empty box, which highlights the last pick.
    await open(input);
    expect(await key(input, "Enter")).toBe(true);
    expect(fieldValues(p.name)).toEqual(before);
  });

  it("Escape never clears picks, closed or open, in either picker", async () => {
    await renderForm(p.defaults);
    const before = { topics: fieldValues("topics"), countries: fieldValues("countries") };
    const input = p.input();
    await act(async () => input.focus());
    await key(input, "Escape"); // closed, empty
    await key(input, "Escape");
    await open(input);
    await key(input, "Escape"); // open
    await type(input, "a");
    await key(input, "Escape"); // open with text
    await key(input, "Escape");
    expect({ topics: fieldValues("topics"), countries: fieldValues("countries") }).toEqual(before);
  });
});

describe("keyboard rules on the topic grid's search", () => {
  const defaults = { topics: [plain[0], plain[1], plain[2], COUNTRIES_TOPIC], countries: ["Kenya"] };

  it("Enter with a matching search is default-prevented, picks nothing and never submits", async () => {
    await renderForm(defaults);
    const before = { topics: fieldValues("topics"), countries: fieldValues("countries") };
    await searchTopics(plain[5]);
    expect(chipNames()).toContain(plain[5]);
    expect(await key(topicSearch(), "Enter")).toBe(true);
    expect({ topics: fieldValues("topics"), countries: fieldValues("countries") }).toEqual(before);
    expect(submitted).toHaveLength(0);
  });

  it("Enter with no match, or an empty box, is default-prevented and changes nothing", async () => {
    await renderForm(defaults);
    const before = { topics: fieldValues("topics"), countries: fieldValues("countries") };
    await searchTopics("zzzz-no-such-thing");
    expect(chipNames()).toEqual([]);
    expect(await key(topicSearch(), "Enter")).toBe(true);
    await searchTopics("");
    expect(await key(topicSearch(), "Enter")).toBe(true);
    expect({ topics: fieldValues("topics"), countries: fieldValues("countries") }).toEqual(before);
    expect(submitted).toHaveLength(0);
  });

  it("a search hides chips but every pick, shown or not, still submits", async () => {
    await renderForm(defaults);
    await searchTopics(plain[5]);
    expect(chipNames()).not.toContain(plain[0]);
    const fd = await submit();
    expect(fd.getAll("topics")).toEqual([plain[0], plain[1], plain[2]]);
    expect(fd.getAll("countries")).toEqual(["Kenya"]);
  });

  it("Escape never clears picks, with or without search text", async () => {
    await renderForm(defaults);
    const before = { topics: fieldValues("topics"), countries: fieldValues("countries") };
    await act(async () => topicSearch().focus());
    await key(topicSearch(), "Escape");
    await searchTopics("a");
    await key(topicSearch(), "Escape");
    await key(topicSearch(), "Escape");
    expect({ topics: fieldValues("topics"), countries: fieldValues("countries") }).toEqual(before);
  });
});

// --- Counter and shared limit ----------------------------------------------

describe("shared counter and limit", () => {
  it("9 topics + 1 country is 10: the Countries topic adds nothing to the count", async () => {
    await renderForm({ topics: plain.slice(0, 9) });
    expect(counter()).toBe("9 of 10");
    await pickWithClick(countriesInput(), "Morocco");
    expect(fieldValues("countries")).toEqual(["Morocco"]);
    expect(counter()).toBe(AT_LIMIT);
    // Now at the limit: unpicked countries and unpicked topic chips are disabled.
    await open(countriesInput());
    expect(optionEl("Kenya")!.getAttribute("aria-disabled")).toBe("true");
    await key(countriesInput(), "Escape");
    expect(chip(plain[9])!.getAttribute("aria-disabled")).toBe("true");
    await clickChip(plain[9]);
    expect(fieldValues("topics")).toEqual(plain.slice(0, 9));

    const fd = await submit();
    expect(fd.getAll("topics")).toEqual(plain.slice(0, 9));
    expect(fd.getAll("countries")).toEqual(["Morocco"]);
    const parsed = ProfileInput.safeParse({
      topics: fd.getAll("topics"),
      preferredSources: fd.getAll("preferredSources"),
      countries: fd.getAll("countries"),
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data!.topics).toEqual([...plain.slice(0, 9), COUNTRIES_TOPIC]);
  });

  it("0 topics + 3 countries counts 3 and is a valid save (Countries topic only)", async () => {
    await renderForm({});
    for (const c of ["Kenya", "Ghana", "Mali"]) await pickWithClick(countriesInput(), c);
    expect(counter()).toBe("3 of 10");
    const fd = await submit();
    expect(fd.getAll("topics")).toEqual([]);
    const parsed = ProfileInput.parse({
      topics: fd.getAll("topics"),
      preferredSources: [],
      countries: fd.getAll("countries"),
    });
    expect(parsed).toEqual({ topics: [COUNTRIES_TOPIC], preferredSources: [], countries: ["Kenya", "Ghana", "Mali"] });
  });

  it("10 countries alone fill the limit, and every topic chip is then disabled", async () => {
    const ten = ["Kenya", "Morocco", "Nigeria", "Uganda", "Senegal", "Ghana", "Egypt", "Tanzania", "Mali", "Zambia"];
    await renderForm({ countries: ten, topics: [COUNTRIES_TOPIC] });
    expect(counter()).toBe(AT_LIMIT);
    await open(countriesInput());
    expect(optionEl("Zimbabwe")!.getAttribute("aria-disabled")).toBe("true");
    await key(countriesInput(), "Escape");
    expect(chips().every((c) => c.getAttribute("aria-disabled") === "true")).toBe(true);
  });

  it("the counter noun switches to 'topics and countries' only while a country is picked", async () => {
    const topics = plain.slice(0, 11);
    await renderForm({ topics });
    const notice = () =>
      [...container.querySelectorAll('p[role="status"]')].find((x) => x.textContent?.includes("limit is now"))
        ?.textContent;
    expect(notice()).toBe("You follow 11 topics; the limit is now 10. Remove 1 before you next save.");
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderForm({ topics: [...plain.slice(0, 10), COUNTRIES_TOPIC], countries: ["Kenya"] });
    expect(counter()).toBe("11 of 10");
    expect(notice()).toBe("You follow 11 topics and countries; the limit is now 10. Remove 1 before you next save.");
  });
});

// --- Round trip: getUserProfile -> form -> ProfileInput -> saveUserProfile ----

function fakeDb(seed: { topics?: string[]; sources?: string[]; subtopics?: { topic: string; subtopic: string }[] }) {
  const uid = "u1";
  const tables: Record<string, Record<string, string>[]> = {
    user_topics: (seed.topics ?? []).map((topic) => ({ user_id: uid, topic })),
    user_preferred_sources: (seed.sources ?? []).map((source) => ({ user_id: uid, source })),
    user_subtopics: (seed.subtopics ?? []).map((r) => ({ user_id: uid, ...r })),
  };
  const filtered = <T,>(run: (m: (r: Record<string, string>) => boolean) => T) => {
    const conds: [string, string][] = [];
    const chain = {
      eq: (k: string, v: string) => {
        conds.push([k, v]);
        return chain;
      },
      then: (res: (v: T) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run((r) => conds.every(([k, v]) => r[k] === v))).then(res, rej),
    };
    return chain;
  };
  const from = (table: string) => {
    if (table === "user_settings") {
      const c = { eq: () => c, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
      return { select: () => c };
    }
    return {
      delete: () =>
        filtered((m) => {
          tables[table] = tables[table].filter((r) => !m(r));
          return { error: null };
        }),
      insert: (rows: Record<string, string>[]) => {
        if (rows.length === 0) return Promise.resolve({ error: { message: "empty insert" } });
        const keyOf = (r: Record<string, string>) => JSON.stringify(Object.entries(r).sort());
        const seen = new Set(tables[table].map(keyOf));
        for (const r of rows) {
          if (seen.has(keyOf(r))) return Promise.resolve({ error: { message: "duplicate key" } });
          seen.add(keyOf(r));
        }
        tables[table].push(...rows);
        return Promise.resolve({ error: null });
      },
      select: (col: string) =>
        filtered((m) => ({ data: tables[table].filter(m).map((r) => ({ [col]: r[col] })), error: null })),
    };
  };
  const rows = () => ({
    topics: tables.user_topics.map((r) => r.topic).sort(),
    sources: tables.user_preferred_sources.map((r) => r.source).sort(),
    subtopics: tables.user_subtopics.map((r) => `${r.topic}|${r.subtopic}`).sort(),
  });
  return { client: { from } as unknown as SupabaseClient, uid, rows };
}

async function roundTrip(db: ReturnType<typeof fakeDb>) {
  const loaded = await getUserProfile(db.client, db.uid);
  await renderForm({ topics: loaded.topics, countries: loaded.countries, sources: loaded.preferredSources });
  const fd = await submit();
  const parsed = ProfileInput.safeParse({
    topics: fd.getAll("topics"),
    preferredSources: fd.getAll("preferredSources"),
    countries: fd.getAll("countries"),
  });
  if (!parsed.success) return { loaded, fd, error: parsed.error.issues[0]?.message };
  const saved = await saveUserProfile(db.client, db.uid, parsed.data.topics, parsed.data.preferredSources, parsed.data.countries);
  return { loaded, fd, error: saved.error };
}

describe("round trip through the real form", () => {
  it("a profile with Countries + countries loads with countries pre-filled, no Countries chip, and re-saves to the same rows", async () => {
    const db = fakeDb({
      topics: [plain[3], COUNTRIES_TOPIC, plain[0]],
      sources: ["BBC"],
      subtopics: [
        { topic: COUNTRIES_TOPIC, subtopic: "Uganda" },
        { topic: COUNTRIES_TOPIC, subtopic: "Kenya" },
      ],
    });
    const before = db.rows();
    const { fd, error } = await roundTrip(db);
    expect(error).toBeNull();
    expect(document.querySelector(`[aria-label="Remove ${COUNTRIES_TOPIC}"]`)).toBeNull();
    expect(fd.getAll("topics")).not.toContain(COUNTRIES_TOPIC);
    expect(fd.getAll("countries")).toEqual(["Kenya", "Uganda"]); // curated order from the read
    expect(counter()).toBe("4 of 10");
    expect(db.rows()).toEqual(before);
  });

  it("a profile without countries re-saves to the same rows, with no Countries topic and no subtopic rows", async () => {
    const db = fakeDb({ topics: plain.slice(0, 4), sources: [] });
    const before = db.rows();
    const { fd, error } = await roundTrip(db);
    expect(error).toBeNull();
    expect(fd.getAll("countries")).toEqual([]);
    expect(db.rows()).toEqual(before);
    expect(db.rows().topics).not.toContain(COUNTRIES_TOPIC);
  });

  it("a profile at the limit (7 topics + 3 countries) round-trips unchanged", async () => {
    const db = fakeDb({
      topics: [...plain.slice(0, 7), COUNTRIES_TOPIC],
      subtopics: ["Mali", "Kenya", "Tanzania"].map((subtopic) => ({ topic: COUNTRIES_TOPIC, subtopic })),
    });
    const before = db.rows();
    const { error } = await roundTrip(db);
    expect(counter()).toBe(AT_LIMIT);
    expect(error).toBeNull();
    expect(db.rows()).toEqual(before);
  });

  it("stray country rows without the Countries topic: the read gives no countries and a re-save deletes them", async () => {
    const db = fakeDb({
      topics: plain.slice(0, 3),
      subtopics: [{ topic: COUNTRIES_TOPIC, subtopic: "Kenya" }],
    });
    const { loaded, fd, error } = await roundTrip(db);
    expect(loaded.countries).toEqual([]);
    expect(fieldValues("countries")).toEqual([]);
    expect(counter()).toBe("3 of 10");
    expect(fd.getAll("countries")).toEqual([]);
    expect(error).toBeNull();
    expect(db.rows()).toEqual({ topics: [...plain.slice(0, 3)].sort(), sources: [], subtopics: [] });
  });

  it("Countries saved whose only country has since been withdrawn: re-save drops the topic and the stale row", async () => {
    const db = fakeDb({
      topics: [...plain.slice(0, 3), COUNTRIES_TOPIC],
      subtopics: [{ topic: COUNTRIES_TOPIC, subtopic: "Atlantis" }],
    });
    const { loaded, error } = await roundTrip(db);
    expect(loaded.topics).toContain(COUNTRIES_TOPIC);
    expect(loaded.countries).toEqual([]);
    expect(counter()).toBe("3 of 10");
    expect(error).toBeNull();
    expect(db.rows()).toEqual({ topics: [...plain.slice(0, 3)].sort(), sources: [], subtopics: [] });
  });

  it("adding a country in the form saves Countries with it; removing every country saves neither", async () => {
    const db = fakeDb({ topics: plain.slice(0, 3) });
    const loaded = await getUserProfile(db.client, db.uid);
    await renderForm({ topics: loaded.topics, countries: loaded.countries });
    await pickWithClick(countriesInput(), "Ghana");
    let fd = await submit();
    let parsed = ProfileInput.parse({ topics: fd.getAll("topics"), preferredSources: [], countries: fd.getAll("countries") });
    await saveUserProfile(db.client, db.uid, parsed.topics, parsed.preferredSources, parsed.countries);
    expect(db.rows().topics).toEqual([...plain.slice(0, 3), COUNTRIES_TOPIC].sort());
    expect(db.rows().subtopics).toEqual([`${COUNTRIES_TOPIC}|Ghana`]);

    await act(async () =>
      document.querySelector<HTMLButtonElement>(`[aria-label="Remove Ghana"]`)!.click()
    );
    await flush();
    fd = await submit();
    parsed = ProfileInput.parse({ topics: fd.getAll("topics"), preferredSources: [], countries: fd.getAll("countries") });
    await saveUserProfile(db.client, db.uid, parsed.topics, parsed.preferredSources, parsed.countries);
    expect(db.rows()).toEqual({ topics: [...plain.slice(0, 3)].sort(), sources: [], subtopics: [] });
  });
});
