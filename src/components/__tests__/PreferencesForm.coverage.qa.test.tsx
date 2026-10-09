// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, TOPICS, type Source, type Topic } from "@/types";
import { FEEDS } from "@/config/feeds";
import { COUNTRIES, COUNTRIES_TOPIC, COUNTRY_FEEDS } from "@/config/countries";
import { COUNTRY_REGIONS } from "@/config/countryRegions";
import { buildSourceCoverage, groupSourcesByCoverage } from "@/lib/sourceCoverage";
import { termMatches, wordsOf } from "@/components/onboarding/TopicGrid";
import { TOPIC_GROUPS } from "@/config/topicGroups";
import { TOPIC_DESCRIPTIONS, TOPIC_SEARCH_TERMS } from "@/config/topicDescriptions";
import type { PreferencesState } from "@/lib/profileErrors";

// QA round 1: the real catalog through the real form, for what the
// implementer's made-up maps do not reach: refused-save survival, the limit in
// the grouped countries list, the section heading under every search, the
// stepped flow regrouping, and the search rule against the real topic text.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/app/auth/actions", () => ({ signOutAction: vi.fn() }));

const { PreferencesForm, SourceCoverageProvider } = await import("@/components/PreferencesForm");
const { OnboardingStepProvider } = await import("@/components/onboarding/OnboardingStepContext");
const { clickChip, chipNames, searchTopics } = await import("./topicGridKit");

const REAL = buildSourceCoverage(FEEDS, COUNTRY_FEEDS);
const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);

type Action = (previous: PreferencesState | void, formData: FormData) => Promise<PreferencesState | void>;
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

const okAction: Action = async (_p, fd) => {
  submitted.push(fd);
};
const refuseAction: Action = async (_p, fd) => {
  submitted.push(fd);
  return { error: "too_few" };
};

async function renderForm(opts: { topics?: Topic[]; countries?: string[]; sources?: Source[]; action?: Action } = {}) {
  const { topics = plain.slice(0, 3), countries = [], sources = [], action = okAction } = opts;
  const all: Topic[] = countries.length > 0 ? [...topics, COUNTRIES_TOPIC] : topics;
  await act(async () =>
    root.render(
      <PreferencesForm
        action={action}
        defaultTopics={all}
        defaultCountries={countries}
        defaultSources={sources}
        sourceCoverage={REAL}
        submitLabel="Save"
      />
    )
  );
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const sourcesInput = () => document.getElementById("preferences-sources") as HTMLInputElement;
const countriesInput = () => document.getElementById("preferences-countries") as HTMLInputElement;
async function key(target: Element, k: string) {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(ev);
  });
  await flush();
  return ev.defaultPrevented;
}
async function open(input: HTMLInputElement) {
  await act(async () => input.focus());
  await key(input, "ArrowDown");
}
async function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: text ? "insertText" : "deleteContentBackward", data: text }));
  });
  await flush();
}
const groups = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="group"]')];
const labelOf = (g: HTMLElement) => document.getElementById(g.getAttribute("aria-labelledby")!)!;
const groupName = (g: HTMLElement) => {
  const l = labelOf(g);
  const s = l.querySelector('[data-slot="combobox-section"]')?.textContent ?? "";
  return l.textContent!.slice(s.length).trim();
};
const rowsIn = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>('[role="option"]')];
const nameOf = (o: HTMLElement) => o.textContent!.split(" · ")[0];
const option = (n: string) => rowsIn(document).find((o) => nameOf(o) === n);
const picked = (n: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${n}"]`)].map((i) => i.value).filter(Boolean);
const notes = () => [...container.querySelectorAll('[data-testid="outlet-coverage-notes"] p')].map((p) => p.textContent);
const headings = () => [...document.querySelectorAll('[data-slot="combobox-section"]')];

describe("real-catalog invariants", () => {
  it("every country is in exactly one region and every region country is a real one", () => {
    const flat = COUNTRY_REGIONS.flatMap((r) => r.countries);
    expect([...flat].sort()).toEqual([...COUNTRIES].sort());
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("each outlet appears exactly once, with no empty group, for assorted picks", () => {
    const samples: [Topic[], string[]][] = [
      [[], []],
      [plain.slice(0, 3), []],
      [plain.slice(0, 10), ["Japan", "France", "Morocco"]],
      [[], [...COUNTRIES]],
      [[...plain], [...COUNTRIES]],
    ];
    for (const [t, c] of samples) {
      const g = groupSourcesByCoverage(REAL, t, c);
      const flat = g.flatMap((x) => x.items);
      expect([...flat].sort()).toEqual([...SOURCES].sort());
      expect(new Set(flat).size).toBe(SOURCES.length);
      expect(g.every((x) => x.items.length > 0)).toBe(true);
      expect(new Set(g.map((x) => x.label)).size).toBe(g.length); // unique keys
    }
  });

  it("no country group label collides with a fixed group label", () => {
    for (const fixed of ["Covers your topics", "Covers your countries", "International", "Everything else"]) {
      expect(COUNTRIES).not.toContain(fixed);
    }
  });

  it("the coverage handed to the browser is names only", () => {
    expect(JSON.stringify(REAL)).not.toMatch(/https?:|\/\//);
  });
});

describe("outlets picker, real catalog, single page", () => {
  it("opens with no picks beyond topics: every outlet listed once across groups", async () => {
    await renderForm();
    await open(sourcesInput());
    const names = rowsIn(document).map(nameOf);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(SOURCES.length);
  });

  it("an outlet in several picked countries is listed once with both countries named", async () => {
    const multi = SOURCES.find((s) => REAL[s].countries.length >= 2 && !REAL[s].topics.some((x) => (plain.slice(0, 3) as readonly string[]).includes(x)))!;
    expect(multi).toBeDefined();
    const [a, b] = REAL[multi].countries;
    await renderForm({ countries: [a, b] });
    await open(sourcesInput());
    const rows = rowsIn(document).filter((o) => nameOf(o) === multi);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe(`${multi} · ${a}, ${b}`);
    expect(groupName(rows[0].closest<HTMLElement>('[role="group"]')!)).toBe("Covers your countries");
  });

  it("search keeps the section heading on the first remaining 'Everything else' group, once", async () => {
    await renderForm();
    await open(sourcesInput());
    for (const q of ["a", "e", "times", "post", "le ", "zzzz", "daily", "bbc", "nation"]) {
      await type(sourcesInput(), q);
      const hs = headings();
      expect(hs.length, q).toBeLessThanOrEqual(1);
      const everything = groups().filter((g) => labelOf(g).querySelector('[data-slot="combobox-section"]'));
      expect(everything.length, q).toBe(hs.length);
      if (hs.length === 1) {
        const first = groups().find((g) => {
          const n = groupName(g);
          return n === "International" || COUNTRIES.includes(n);
        })!;
        expect(everything[0], q).toBe(first);
        // accessible name keeps heading and label two words
        expect(labelOf(everything[0]).textContent, q).toMatch(/^Everything else \S/);
      }
      for (const g of groups()) expect(rowsIn(g).length, q).toBeGreaterThan(0);
    }
  });

  it("regroups live: unpicking a topic moves a picked outlet and raises the no-coverage note; hidden input stays", async () => {
    // pick a topic that exactly one of the fixture topics gives to a chosen outlet
    const topics = plain.slice(0, 3);
    const outlet = SOURCES.find((s) => REAL[s].topics.includes(topics[0]) && !REAL[s].topics.includes(topics[1]) && !REAL[s].topics.includes(topics[2]))!;
    expect(outlet).toBeDefined();
    await renderForm({ topics, sources: [outlet] });
    expect(notes().join("|")).not.toContain(outlet);
    await clickChip(topics[0]);
    expect(notes().join("|")).toContain(`${outlet} publishes nothing in your topics yet`);
    expect(picked("preferredSources")).toEqual([outlet]);
    await clickChip(topics[0]);
    expect(notes().join("|")).not.toContain(outlet);
  });

  it("Enter/Escape rules with real groups", async () => {
    await renderForm({ sources: ["BBC"] });
    const input = sourcesInput();
    await open(input);
    await type(input, "bbc");
    // picked item highlighted: Enter must not toggle it off, and must not submit
    expect(await key(input, "Enter")).toBe(true);
    expect(picked("preferredSources")).toEqual(["BBC"]);
    await type(input, "zzzz");
    expect(await key(input, "Enter")).toBe(true);
    await key(input, "Escape");
    await key(input, "Escape");
    await key(input, "Escape");
    expect(picked("preferredSources")).toEqual(["BBC"]);
    expect(submitted).toHaveLength(0);
  });

  it("Enter on a search with a match adds the highlighted outlet", async () => {
    await renderForm();
    const input = sourcesInput();
    await open(input);
    await type(input, "kicker");
    await key(input, "Enter");
    expect(picked("preferredSources")).toEqual(["Kicker"]);
  });
});

describe("refused save keeps grouped picks", () => {
  it("sources and countries survive the form reset after a refusal, and the page still submits them", async () => {
    await renderForm({ action: refuseAction, countries: ["Japan"], sources: ["BBC"] });
    await open(countriesInput());
    await act(async () => option("Kenya")!.click());
    await flush();
    await key(countriesInput(), "Escape");
    await open(sourcesInput());
    await act(async () => option("Kicker")!.click());
    await flush();
    await key(sourcesInput(), "Escape");
    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();
    await flush();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].getAll("countries").sort()).toEqual(["Japan", "Kenya"]);
    expect(submitted[0].getAll("preferredSources").sort()).toEqual(["BBC", "Kicker"]);
    // after React 19's post-action form reset the hidden inputs are still there
    expect(picked("countries").sort()).toEqual(["Japan", "Kenya"]);
    expect(picked("preferredSources").sort()).toEqual(["BBC", "Kicker"]);
    // resubmit sends the same thing
    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();
    expect(submitted[1].getAll("countries").sort()).toEqual(["Japan", "Kenya"]);
    expect(submitted[1].getAll("preferredSources").sort()).toEqual(["BBC", "Kicker"]);
  });
});

describe("the limit in the grouped countries list", () => {
  it("at the limit, unpicked countries are disabled in every region, picked ones stay enabled, clicking adds nothing", async () => {
    const topics = plain.slice(0, 9);
    await renderForm({ topics, countries: ["Japan"] }); // 9 topics + Countries(1 country) = 10
    await open(countriesInput());
    const rows = rowsIn(document);
    expect(rows.length).toBe(COUNTRIES.length);
    for (const r of rows) {
      const isJapan = nameOf(r) === "Japan";
      expect(r.hasAttribute("data-disabled") || r.getAttribute("aria-disabled") === "true", nameOf(r)).toBe(!isJapan);
    }
    expect(groups().map(groupName)).toEqual(COUNTRY_REGIONS.map((r) => r.name));
    await act(async () => option("Kenya")!.click());
    await flush();
    expect(picked("countries")).toEqual(["Japan"]);
    // keyboard Enter on a disabled highlighted match: held, adds nothing, no submit
    await type(countriesInput(), "kenya");
    expect(await key(countriesInput(), "Enter")).toBe(true);
    expect(picked("countries")).toEqual(["Japan"]);
    expect(submitted).toHaveLength(0);
    // removing frees the limit
    await type(countriesInput(), "");
    await act(async () => option("Japan")!.click());
    await flush();
    expect(picked("countries")).toEqual([]);
  });
});

describe("stepped onboarding with the provider", () => {
  const visible = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.closest("[hidden]") === null && b.textContent === name)!;
  const press = async (name: string) => {
    await act(async () => visible(name).click());
    await flush();
  };
  async function renderStepped() {
    await act(async () =>
      root.render(
        <OnboardingStepProvider>
          <SourceCoverageProvider coverage={REAL}>
            <PreferencesForm stepped action={okAction} submitLabel="Save and continue" />
          </SourceCoverageProvider>
        </OnboardingStepProvider>
      )
    );
  }

  it("outlets step regroups from topics and countries picked on earlier steps, and the review names coverage", async () => {
    await renderStepped();
    const t = plain.slice(0, 3);
    for (const topic of t) await clickChip(topic);
    await press("Next: Countries");
    await open(countriesInput());
    await act(async () => option("Japan")!.click());
    await flush();
    await key(countriesInput(), "Escape");
    await press("Next: Outlets");
    await open(sourcesInput());
    const names = groups().map(groupName);
    expect(names[0] === "Covers your topics" || names[0] === "Covers your countries").toBe(true);
    const jt = option("Japan Times")!;
    expect(jt).toBeDefined();
    await act(async () => jt.click());
    await flush();
    await key(sourcesInput(), "Escape");
    await press("Next: Review");
    const dd = container.querySelector('[data-testid="review-outlets"]')!;
    expect(dd.textContent).toMatch(/^Japan Times covers /);
    expect(dd.textContent).toContain("1 of your countries");
    // go back, drop the country: the line must now say none
    const edit = [...container.querySelectorAll<HTMLElement>("a,button")].find((e) => /edit/i.test(e.textContent ?? "") && e.closest("[hidden]") === null);
    expect(edit).toBeDefined();
  });
});

describe("topic search against the real topic text", () => {
  const topics = TOPIC_GROUPS.flatMap((g) => g.topics);
  const words = new Map(
    topics.map((t) => {
      const key = t as keyof typeof TOPIC_DESCRIPTIONS;
      return [t, wordsOf(`${t} ${TOPIC_DESCRIPTIONS[key] ?? ""} ${TOPIC_SEARCH_TERMS[key] ?? ""}`)];
    })
  );
  const hits = (q: string) => topics.filter((t) => wordsOf(q).every((term) => words.get(t)!.some((w) => termMatches(w, term))));

  it("finds what the brief says it finds, and not what it says it must not", () => {
    expect(hits("elect")).toContain("Elections");
    expect(hits("ai")).toEqual(expect.arrayContaining(["Tech/AI", "Travel"]));
    expect(hits("ai")).not.toContain("Retail");
    expect(hits("ai")).not.toContain("Religion");
    expect(hits("morocco")).toEqual(["Morocco Politics", "Morocco Finance"]);
  });

  it("every topic is found by its own full name, typed in lower case", () => {
    for (const t of topics) expect(hits(t.toLowerCase()), t).toContain(t);
  });

  it("every topic is found by each prefix of its name from 2 letters up", () => {
    for (const t of topics) for (const w of wordsOf(t)) for (let n = 2; n <= w.length; n++) expect(hits(w.slice(0, n)), `${t}:${w.slice(0, n)}`).toContain(t);
  });

  it("no search of 5+ letters that is a whole topic word floods the grid (>12 hits)", () => {
    const all = new Set([...words.values()].flat().filter((w) => w.length >= 5));
    for (const w of all) expect(hits(w).length, w).toBeLessThanOrEqual(12);
  });

  it("the grid itself narrows on 'elect' and shows the empty line for nonsense", async () => {
    await act(async () =>
      root.render(<PreferencesForm action={okAction} defaultTopics={plain.slice(0, 3)} submitLabel="Save" />)
    );
    await searchTopics("elect");
    expect(chipNames()).toEqual(expect.arrayContaining(["Elections"]));
    await searchTopics("qqqqq");
    expect(container.textContent).toContain("No topic matches “qqqqq”.");
    await searchTopics("  /  ");
    expect(chipNames().length).toBe(topics.length);
  });
});
