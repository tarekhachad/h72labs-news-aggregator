// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CountryFacts } from "@/lib/panels/countryFacts";
import { CountryFactsBox } from "../CountryFactsBox";

const MOROCCO: CountryFacts = {
  country: "Morocco",
  worldBank: {
    capital: "Rabat",
    population: { value: 38_430_770, year: 2025 },
    gdpUsd: { value: 154_400_000_000, year: 2024 },
    inflationPct: { value: 0.93, year: 2025 },
  },
  wikidata: {
    entity: "Q1028",
    retrievedOn: "2026-10-13",
    currency: [{ id: "Q200192", label: "Moroccan dirham" }],
    headOfState: [{ id: "Q57553", label: "Mohammed VI of Morocco" }],
    headOfGovernment: [{ id: "Q3378813", label: "Aziz Akhannouch" }],
  },
};

function render(facts: CountryFacts) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<CountryFactsBox facts={facts} />);
  const rows = [...host.querySelectorAll("dl > div")].map((row) =>
    [...row.children].map((cell) => cell.textContent)
  );
  return { host, rows, credits: host.querySelector("p")?.textContent ?? "" };
}

describe("CountryFactsBox", () => {
  it("lists each fact with its source and year, under a labelled band", () => {
    const { host, rows } = render(MOROCCO);
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Morocco at a glance");
    expect(host.querySelector("h2")?.textContent).toBe("Morocco at a glance");
    expect(rows).toEqual([
      ["Capital", "Rabat", "World Bank"],
      ["Currency", "Moroccan dirham", "Wikidata, as of Oct 13, 2026"],
      ["Population", "38.4 million (2025)", "World Bank"],
      ["GDP", "$154.4 bn (2024)", "World Bank"],
      ["Inflation", "0.9% (2025)", "World Bank"],
      ["Head of state", "Mohammed VI of Morocco", "Wikidata, as of Oct 13, 2026"],
      ["Head of government", "Aziz Akhannouch", "Wikidata, as of Oct 13, 2026"],
    ]);
  });

  it("credits both sources with their licences and links", () => {
    const { host, credits } = render(MOROCCO);
    expect(credits).toContain("World Bank, World Development Indicators");
    expect(credits).toContain("CC BY 4.0");
    expect(credits).toContain("Wikidata");
    expect(credits).toContain("CC0");
    const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://datacatalog.worldbank.org/search/dataset/0037712/World-Development-Indicators",
      "https://creativecommons.org/licenses/by/4.0/",
      "https://www.wikidata.org/wiki/Q1028",
    ]);
    for (const a of host.querySelectorAll("a")) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows one person holding both roles once", () => {
    const king = [{ id: "Q1", label: "The Ruler" }];
    const { rows } = render({ ...MOROCCO, wikidata: { ...MOROCCO.wikidata!, headOfState: king, headOfGovernment: king } });
    const leaders = rows.filter(([label]) => label?.startsWith("Head of"));
    expect(leaders).toEqual([["Head of state and government", "The Ruler", "Wikidata, as of Oct 13, 2026"]]);
  });

  it("joins two holders of one role", () => {
    const { rows } = render({
      ...MOROCCO,
      wikidata: {
        ...MOROCCO.wikidata!,
        headOfState: [
          { id: "Q1", label: "First Co-Prince" },
          { id: "Q2", label: "Second Co-Prince" },
        ],
      },
    });
    expect(rows.find(([label]) => label === "Head of state")?.[1]).toBe("First Co-Prince and Second Co-Prince");
  });

  it("shows only the facts that came back, and credits only the source that supplied them", () => {
    const onlyWorldBank = render({ ...MOROCCO, wikidata: null });
    expect(onlyWorldBank.rows.map(([label]) => label)).toEqual(["Capital", "Population", "GDP", "Inflation"]);
    expect(onlyWorldBank.credits).not.toContain("Wikidata");

    const onlyWikidata = render({ ...MOROCCO, worldBank: null });
    expect(onlyWikidata.rows.map(([label]) => label)).toEqual(["Currency", "Head of state", "Head of government"]);
    expect(onlyWikidata.credits).not.toContain("World Bank");

    const partial = render({
      ...MOROCCO,
      worldBank: { capital: null, population: null, gdpUsd: null, inflationPct: { value: 2, year: 2023 } },
      wikidata: { ...MOROCCO.wikidata!, currency: [], headOfGovernment: [] },
    });
    expect(partial.rows.map(([label]) => label)).toEqual(["Inflation", "Head of state"]);
  });

  it("renders nothing at all when no fact is left", () => {
    const empty = renderToStaticMarkup(
      <CountryFactsBox
        facts={{
          country: "Morocco",
          worldBank: { capital: null, population: null, gdpUsd: null, inflationPct: null },
          wikidata: { ...MOROCCO.wikidata!, currency: [], headOfState: [], headOfGovernment: [] },
        }}
      />
    );
    expect(empty).toBe("");
  });

  it.each(["garbage", "", "2026-13-45", "2026-10-13T00:00:00Z"])(
    "falls back to a plain Wikidata source for a stored day of %j",
    (retrievedOn) => {
      const { rows } = render({ ...MOROCCO, wikidata: { ...MOROCCO.wikidata!, retrievedOn } });
      expect(rows.find(([label]) => label === "Currency")).toEqual(["Currency", "Moroccan dirham", "Wikidata"]);
    }
  );

  it("renders upstream strings as text, never as markup", () => {
    const { host } = render({
      ...MOROCCO,
      worldBank: { ...MOROCCO.worldBank!, capital: '<img src=x onerror="alert(1)">' },
      wikidata: { ...MOROCCO.wikidata!, headOfState: [{ id: "Q1", label: "<script>alert(1)</script>" }] },
    });
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
