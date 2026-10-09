// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOPICS } from "@/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/app/auth/actions", () => ({ signOutAction: vi.fn() }));

const { COUNTRIES_TOPIC } = await import("@/config/countries");
const { PreferencesForm } = await import("@/components/PreferencesForm");
const { OnboardingStepProvider } = await import("@/components/onboarding/OnboardingStepContext");

const plain = TOPICS.filter((t) => t !== COUNTRIES_TOPIC);
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

async function render(topics: typeof plain, countries: string[]) {
  await act(async () =>
    root.render(
      <OnboardingStepProvider>
        <PreferencesForm
          stepped
          action={async () => undefined}
          submitLabel="Save"
          defaultTopics={topics}
          defaultCountries={countries}
        />
      </OnboardingStepProvider>
    )
  );
}
const firstStep = () => container.querySelector<HTMLElement>("form > section")!;

describe("round 2 qa: countries above the grid, one counter", () => {
  it("DOM order: countries input, then the grid counter, then the topic search; counter is the describedby target", async () => {
    await render([], []);
    const step = firstStep();
    const countries = step.querySelector("#preferences-countries")!;
    const counter = step.querySelector("#preferences-topics-count")!;
    const topicSearch = step.querySelector('input[type="search"], input[placeholder="Search topics"]')!;
    expect(countries.compareDocumentPosition(counter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(counter.compareDocumentPosition(topicSearch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const ids = (countries.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toContain("preferences-topics-count");
    for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
  });

  it("exactly one counter and one polite counter live region on the visible step; none for countries", async () => {
    await render([], []);
    const step = firstStep();
    expect(step.querySelectorAll('[id$="-count"]')).toHaveLength(1);
    expect(step.querySelectorAll('[aria-live="polite"]#preferences-topics-count')).toHaveLength(1);
    expect(step.querySelector("#preferences-countries-count")).toBeNull();
  });

  it("an over-limit saved profile (8 topics + 5 countries) shows its over-limit notice once, not twice", async () => {
    await render(plain.slice(0, 8), ["Morocco", "Kenya", "Ghana", "Egypt", "Nigeria"]);
    const step = firstStep();
    const counter = step.querySelector("#preferences-topics-count")!.textContent!;
    console.log("over-limit counter text:", JSON.stringify(counter));
    expect(step.querySelectorAll('[id$="-count"]')).toHaveLength(1);
    const text = step.textContent!;
    const occurrences = (text.match(/limit/gi) ?? []).length;
    console.log("occurrences of 'limit' on step:", occurrences);
    expect(counter).toMatch(/13 of 10/);
    expect(step.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });
});
