// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CountryFacts } from "@/lib/panels/countryFacts";
import { CountryFactsBox } from "../CountryFactsBox";

const base = (over: Partial<CountryFacts>): CountryFacts => ({ country: "Morocco", worldBank: null, wikidata: null, ...over });
const wd = (over: object) => ({
  entity: "Q1028",
  retrievedOn: "2026-10-13",
  currency: [],
  headOfState: [],
  headOfGovernment: [],
  ...over,
});

describe("CountryFactsBox edges", () => {
  it("escapes hostile labels", () => {
    const html = renderToStaticMarkup(
      <CountryFactsBox facts={base({ wikidata: wd({ currency: [{ id: "Q1", label: "<script>alert(1)</script>" }] }) })} />
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("renders nothing when everything is empty", () => {
    expect(renderToStaticMarkup(<CountryFactsBox facts={base({ wikidata: wd({}) })} />)).toBe("");
  });
  it("one person in both roles shows once; same two people in different order shows once", () => {
    const a = { id: "Q1", label: "A" };
    const b = { id: "Q2", label: "B" };
    const html = renderToStaticMarkup(
      <CountryFactsBox facts={base({ wikidata: wd({ headOfState: [a, b], headOfGovernment: [b, a] }) })} />
    );
    expect(html.match(/Head of/g)).toHaveLength(1);
    expect(html).toContain("Head of state and government");
  });
  it("different people show both rows", () => {
    const html = renderToStaticMarkup(
      <CountryFactsBox
        facts={base({ wikidata: wd({ headOfState: [{ id: "Q1", label: "A" }], headOfGovernment: [{ id: "Q2", label: "B" }] }) })}
      />
    );
    expect(html).toContain("Head of state<");
    expect(html).toContain("Head of government<");
  });
  it("credits only the source that supplied a fact", () => {
    const html = renderToStaticMarkup(
      <CountryFactsBox facts={base({ worldBank: { capital: "Rabat", population: null, gdpUsd: null, inflationPct: null } })} />
    );
    expect(html).toContain("World Bank");
    expect(html).not.toContain("wikidata.org");
  });
  it("zero inflation still renders", () => {
    const html = renderToStaticMarkup(
      <CountryFactsBox
        facts={base({ worldBank: { capital: null, population: null, gdpUsd: null, inflationPct: { value: 0, year: 2024 } } })}
      />
    );
    expect(html).toContain("0.0% (2024)");
  });
  it("a corrupt cached retrievedOn does not throw", () => {
    expect(() =>
      renderToStaticMarkup(
        <CountryFactsBox facts={base({ wikidata: wd({ retrievedOn: "garbage", currency: [{ id: "Q1", label: "X" }] }) })} />
      )
    ).not.toThrow();
  });
});
