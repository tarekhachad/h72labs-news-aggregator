// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PreferencesForm } from "@/components/PreferencesForm";
import { termMatches, wordsOf } from "@/components/onboarding/TopicGrid";
import { chipNames, searchTopics } from "@/components/__tests__/topicGridKit";

// The topic grid's search matches the start of words in a topic's name and
// description, and a long enough term also matches on its stem: "morocco"
// finds "Moroccan", "elect" finds "Elections", and "ai" finds "AI" without
// matching every word with "ai" inside it.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the search rule", () => {
  const matchesAny = (text: string, term: string) => wordsOf(text).some((word) => termMatches(word, term));

  it("matches a term at the start of any word, after folding accents and case", () => {
    expect(matchesAny("Tech/AI", "ai")).toBe(true);
    expect(matchesAny("Elections", "elect")).toBe(true);
    expect(matchesAny("Élysée and the Assemblée", "elysee")).toBe(true);
    expect(matchesAny("Japanese politics", "japan")).toBe(true);
  });

  it("never matches inside a word", () => {
    expect(matchesAny("Retail and consumer brands", "ai")).toBe(false);
    expect(matchesAny("Religion and faith", "ai")).toBe(false);
    expect(matchesAny("Business news", "us")).toBe(false);
  });

  it("lets a term of six letters or more match on a stem of at least five", () => {
    expect(matchesAny("Moroccan football", "morocco")).toBe(true);
    expect(matchesAny("Political parties", "politics")).toBe(true);
    expect(matchesAny("German economy", "germany")).toBe(true);
    // The stem is never shorter than five letters…
    expect(matchesAny("Morning briefing", "morocco")).toBe(false);
    expect(matchesAny("Frenzy", "france")).toBe(false);
    // …and a five-letter term has no stem: it must begin the word.
    expect(matchesAny("Spare parts", "space")).toBe(false);
  });
});

describe("searching the topic grid", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<PreferencesForm action={async () => {}} submitLabel="Save" />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("'morocco' finds Football, whose description says Moroccan", async () => {
    await searchTopics("morocco");
    expect(chipNames()).toContain("Football");
  });

  it("'elect' finds Elections", async () => {
    await searchTopics("elect");
    expect(chipNames()).toContain("Elections");
  });

  it("'ai' finds Tech/AI without the topics that only have 'ai' inside a word", async () => {
    await searchTopics("ai");
    const shown = chipNames();
    expect(shown).toContain("Tech/AI");
    expect(shown).not.toContain("Retail & Consumer");
    expect(shown).not.toContain("Religion");
    expect(shown.length).toBeLessThanOrEqual(3);
  });

  it("reads a typed name with punctuation as its words", async () => {
    await searchTopics("tech/ai");
    expect(chipNames()).toEqual(["Tech/AI"]);
  });

  it("still says so when nothing matches", async () => {
    await searchTopics("xyzzy");
    expect(chipNames()).toEqual([]);
    expect(container.textContent).toContain("No topic matches “xyzzy”.");
  });
});
