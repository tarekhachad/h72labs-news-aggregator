// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SOURCES, type Source, type Topic } from "@/types";
import { buildSourceCoverage } from "@/lib/sourceCoverage";
import type { PreferencesState } from "@/lib/profileErrors";

// The outlets picker sorted by what each outlet covers for the reader's
// current picks, the note under a pick that covers none of them, the review
// step's coverage lines, and the picker's keyboard rules with groups. A small
// made-up coverage map keeps the expectations apart from the real catalog.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/app/auth/actions", () => ({ signOutAction: vi.fn() }));

const { PreferencesForm, SourceCoverageProvider } = await import("@/components/PreferencesForm");
const { OnboardingStepProvider } = await import("@/components/onboarding/OnboardingStepContext");
const { clickChip } = await import("./topicGridKit");

const COVERAGE = buildSourceCoverage(
  {
    "Tech/AI": { BBC: "u", TechCrunch: "u", "The Verge": "u" },
    Cybersecurity: { BBC: "u", TechCrunch: "u" },
    Gaming: { BBC: "u", IGN: "u" },
    Football: { Kicker: "u", BBC: "u" },
  },
  {
    Japan: { "Japan Times": "u", "The Guardian": "u" },
    France: { "Le Monde": "u", "The Guardian": "u" },
    Kenya: { "Nation (Kenya)": "u" },
  }
);
const TOPICS3: Topic[] = ["Tech/AI", "Cybersecurity", "Gaming"];

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

const action: Action = async (_previous, formData) => {
  submitted.push(formData);
};

async function renderForm({
  topics = TOPICS3,
  countries = [],
  sources = [],
  coverage = true,
}: { topics?: Topic[]; countries?: string[]; sources?: Source[]; coverage?: boolean } = {}) {
  const withCountries: Topic[] = countries.length > 0 ? [...topics, "Countries" as Topic] : topics;
  await act(async () =>
    root.render(
      <PreferencesForm
        action={action}
        defaultTopics={withCountries}
        defaultCountries={countries}
        defaultSources={sources}
        sourceCoverage={coverage ? COVERAGE : undefined}
        submitLabel="Save"
      />
    )
  );
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const sourcesInput = () => document.getElementById("preferences-sources") as HTMLInputElement;
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

async function close(input: HTMLInputElement) {
  await key(input, "Escape");
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

const groups = () => [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="group"]')];
/** A group's label without its section heading. */
const groupName = (group: HTMLElement) => {
  const label = document.getElementById(group.getAttribute("aria-labelledby")!)!;
  const section = label.querySelector('[data-slot="combobox-section"]')?.textContent ?? "";
  return label.textContent!.slice(section.length).trim();
};
const group = (name: string) => groups().find((g) => groupName(g) === name);
const rowsIn = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent);
const sections = () =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [data-slot="combobox-section"]')].map((s) => ({
    text: s.textContent,
    over: groupName(s.closest<HTMLElement>('[role="group"]')!),
  }));
const option = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find(
    (o) => o.textContent === name || o.textContent!.startsWith(`${name} · `)
  );
const picked = (name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)].map((i) => i.value).filter(Boolean);
const notes = () =>
  [...container.querySelectorAll('[data-testid="outlet-coverage-notes"] p')].map((p) => p.textContent);

async function pickSource(name: string) {
  await open(sourcesInput());
  await act(async () => option(name)!.click());
  await flush();
  await close(sourcesInput());
}

describe("the outlets picker, sorted by coverage", () => {
  it("is the plain list of every outlet without a coverage map", async () => {
    await renderForm({ coverage: false });
    await open(sourcesInput());
    expect(groups()).toHaveLength(0);
    expect(rowsIn(document.querySelector('[role="listbox"]')!)).toEqual([...SOURCES]);
  });

  it("puts the outlets covering the reader's topics first, most topics first, with the count", async () => {
    await renderForm();
    await open(sourcesInput());
    expect(groupName(groups()[0])).toBe("Covers your topics");
    expect(rowsIn(groups()[0])).toEqual([
      "BBC · 3 of your topics",
      "TechCrunch · 2 of your topics",
      "IGN · 1 of your topics",
      "The Verge · 1 of your topics",
    ]);
  });

  it("then the outlets covering the reader's countries, naming them", async () => {
    await renderForm({ countries: ["Japan", "France"] });
    await open(sourcesInput());
    expect(groups().map(groupName).slice(0, 2)).toEqual(["Covers your topics", "Covers your countries"]);
    expect(rowsIn(group("Covers your countries")!)).toEqual([
      "Japan Times · Japan",
      "Le Monde · France",
      "The Guardian · France, Japan",
    ]);
  });

  it("then everything else under one heading, International first and then by country", async () => {
    await renderForm({ countries: ["Japan"] });
    await open(sourcesInput());
    const names = groups().map(groupName);
    const rest = names.slice(names.indexOf("International"));
    expect(rest).toEqual(["International", "France", "Kenya"]);
    expect(sections()).toEqual([{ text: "Everything else", over: "International" }]);
    // Read as two words, not "Everything elseInternational".
    const international = group("International")!;
    expect(document.getElementById(international.getAttribute("aria-labelledby")!)!.textContent).toBe(
      "Everything else International"
    );
    expect(rowsIn(group("France")!)).toEqual(["Le Monde"]);
    expect(rowsIn(group("Kenya")!)).toEqual(["Nation (Kenya)"]);
    // Kicker covers only Football, which isn't picked: no count.
    expect(rowsIn(group("International")!)).toContain("Kicker");
  });

  it("lists every outlet exactly once", async () => {
    await renderForm({ countries: ["Japan"] });
    await open(sourcesInput());
    const names = groups()
      .flatMap((g) => rowsIn(g))
      .map((row) => row!.split(" · ")[0]);
    expect([...names].sort()).toEqual([...SOURCES].sort());
  });

  it("regroups as the reader picks topics and countries", async () => {
    await renderForm();
    await clickChip("Football");
    await open(sourcesInput());
    expect(rowsIn(group("Covers your topics")!)).toContain("Kicker · 1 of your topics");
    expect(rowsIn(group("Covers your topics")!)[0]).toBe("BBC · 4 of your topics");
    await close(sourcesInput());

    await clickChip("Gaming");
    await open(sourcesInput());
    expect(rowsIn(group("Covers your topics")!)).not.toContain("IGN · 1 of your topics");
    expect(rowsIn(group("International")!)).toContain("IGN");
    await close(sourcesInput());

    expect(group("Covers your countries")).toBeUndefined();
    await open(countriesInput());
    await act(async () => option("Kenya")!.click());
    await flush();
    await close(countriesInput());
    await open(sourcesInput());
    expect(rowsIn(group("Covers your countries")!)).toEqual(["Nation (Kenya) · Kenya"]);
    expect(group("Kenya")).toBeUndefined();
  });

  it("filters across the groups, hides empty ones, and keeps the heading over the first remaining", async () => {
    await renderForm({ countries: ["Japan"] });
    await open(sourcesInput());
    await type(sourcesInput(), "nation (k");
    expect(groups().map(groupName)).toEqual(["Kenya"]);
    expect(sections()).toEqual([{ text: "Everything else", over: "Kenya" }]);

    await type(sourcesInput(), "bbc");
    expect(groups().map(groupName)).toEqual(["Covers your topics"]);
    expect(sections()).toEqual([]);

    // The search matches the name, not the count after it.
    await type(sourcesInput(), "your topics");
    expect(groups()).toHaveLength(0);
  });
});

describe("the note under a pick that covers none of the reader's picks", () => {
  it("names the outlet, and goes once it covers a pick", async () => {
    await renderForm({ sources: ["Kicker", "BBC"] });
    expect(notes()).toEqual(["Kicker publishes nothing in your topics yet, so it won't change your edition."]);
    await clickChip("Football");
    expect(notes()).toEqual([]);
  });

  it("says topics or countries once a country is picked, and spares an outlet covering one", async () => {
    await renderForm({ countries: ["Japan"], sources: ["Kicker", "Japan Times"] });
    expect(notes()).toEqual([
      "Kicker publishes nothing in your topics or countries yet, so it won't change your edition.",
    ]);
  });

  it("appears when the reader picks such an outlet and leaves when they remove it", async () => {
    await renderForm();
    expect(notes()).toEqual([]);
    await pickSource("Le Monde");
    expect(notes()).toEqual(["Le Monde publishes nothing in your topics yet, so it won't change your edition."]);
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Remove Le Monde"]')!.click());
    await flush();
    expect(notes()).toEqual([]);
  });

  it("sits in a live region that is there before any note", async () => {
    await renderForm();
    const region = container.querySelector('[data-testid="outlet-coverage-notes"]')!;
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("isn't shown without a coverage map", async () => {
    await renderForm({ coverage: false, sources: ["Kicker"] });
    expect(notes()).toEqual([]);
  });
});

describe("picking from the grouped outlets", () => {
  it("submits preferredSources exactly as picked", async () => {
    await renderForm({ sources: ["Kicker"] });
    await pickSource("BBC");
    await pickSource("Le Monde");
    await act(async () => container.querySelector("form")!.requestSubmit());
    await flush();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].getAll("preferredSources")).toEqual(["Kicker", "BBC", "Le Monde"]);
  });

  it("Enter while searching picks the first match and never submits", async () => {
    await renderForm();
    await open(sourcesInput());
    await type(sourcesInput(), "techc");
    expect(await key(sourcesInput(), "Enter")).toBe(true);
    expect(picked("preferredSources")).toEqual(["TechCrunch"]);
    expect(submitted).toHaveLength(0);
  });

  it("keyboard Enter only adds: on a picked outlet it keeps the pick", async () => {
    await renderForm({ sources: ["BBC"] });
    await open(sourcesInput());
    await type(sourcesInput(), "bbc");
    await key(sourcesInput(), "Enter");
    expect(picked("preferredSources")).toEqual(["BBC"]);
  });

  it("Escape never clears the picks, open or closed", async () => {
    await renderForm({ sources: ["BBC", "Kicker"] });
    await open(sourcesInput());
    await key(sourcesInput(), "Escape");
    await key(sourcesInput(), "Escape");
    await key(sourcesInput(), "Escape");
    expect(picked("preferredSources")).toEqual(["BBC", "Kicker"]);
  });
});

describe("the review step's outlet lines", () => {
  async function renderStepped(coverage: boolean) {
    await act(async () =>
      root.render(
        <OnboardingStepProvider>
          {coverage ? (
            <SourceCoverageProvider coverage={COVERAGE}>
              <PreferencesForm stepped action={action} submitLabel="Save and continue" />
            </SourceCoverageProvider>
          ) : (
            <PreferencesForm stepped action={action} submitLabel="Save and continue" />
          )}
        </OnboardingStepProvider>
      )
    );
  }

  const visibleButton = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.closest("[hidden]") === null && b.textContent === name
    )!;
  async function press(name: string) {
    await act(async () => visibleButton(name).click());
    await flush();
  }
  const outletsRow = () =>
    [...container.querySelectorAll("dl > div")].find((row) => row.querySelector("dt")!.textContent === "Outlets")!;

  async function toReview(sources: Source[], countries: string[] = []) {
    for (const topic of TOPICS3) await clickChip(topic);
    await press("Next: Countries");
    for (const country of countries) {
      await open(countriesInput());
      await act(async () => option(country)!.click());
      await flush();
      await close(countriesInput());
    }
    await press(countries.length > 0 ? "Next: Outlets" : "Skip");
    for (const source of sources) await pickSource(source);
    await press(sources.length > 0 ? "Next: Review" : "Skip");
  }

  it("says how many of the reader's topics and countries each picked outlet covers", async () => {
    await renderStepped(true);
    await toReview(["BBC", "Kicker", "The Guardian"], ["France"]);
    const lines = [...outletsRow().querySelectorAll("li")].map((li) => li.textContent);
    expect(lines).toEqual(["BBC covers 3 of your topics", "Kicker covers none", "The Guardian covers 1 of your countries"]);
  });

  it("says every outlet when none is picked", async () => {
    await renderStepped(true);
    await toReview([]);
    expect(outletsRow().textContent).toContain("Every outlet for your topics");
  });

  it("names the picks without a coverage map", async () => {
    await renderStepped(false);
    await toReview(["BBC", "Kicker"]);
    expect(outletsRow().querySelector("li")).toBeNull();
    expect(outletsRow().textContent).toContain("BBC, Kicker");
  });

  it("shows the outlets step grouped from the provider's map", async () => {
    await renderStepped(true);
    for (const topic of TOPICS3) await clickChip(topic);
    await press("Next: Countries");
    await press("Skip");
    await open(sourcesInput());
    expect(groupName(groups()[0])).toBe("Covers your topics");
  });
});
