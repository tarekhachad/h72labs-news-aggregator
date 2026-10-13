import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorldBankFacts, WORLD_BANK_INDICATORS } from "../worldBank";
import { PanelFetchError } from "../fetchJson";
import { jsonResponse, wbCountry, wbIndicator, wbNoData, wbUnknownCountry } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

type Answers = { country?: unknown; population?: unknown; gdp?: unknown; inflation?: unknown };

function stubWorldBank(answers: Answers = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const pick = (body: unknown) => (body instanceof Response ? body : jsonResponse(body));
    if (path.endsWith(WORLD_BANK_INDICATORS.population)) {
      return pick(answers.population ?? wbIndicator("SP.POP.TOTL", "MA", "2025", 38430770));
    }
    if (path.endsWith(WORLD_BANK_INDICATORS.gdpUsd)) {
      return pick(answers.gdp ?? wbIndicator("NY.GDP.MKTP.CD", "MA", "2024", 154_400_000_000));
    }
    if (path.endsWith(WORLD_BANK_INDICATORS.inflationPct)) {
      return pick(answers.inflation ?? wbIndicator("FP.CPI.TOTL.ZG", "MA", "2025", 0.93));
    }
    return pick(answers.country ?? wbCountry("MA", "Rabat"));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchWorldBankFacts", () => {
  it("reads the capital and each indicator's latest value with its year", async () => {
    stubWorldBank();
    await expect(fetchWorldBankFacts("MA")).resolves.toEqual({
      capital: "Rabat",
      population: { value: 38430770, year: 2025 },
      gdpUsd: { value: 154_400_000_000, year: 2024 },
      inflationPct: { value: 0.93, year: 2025 },
    });
  });

  it("builds every URL from the code alone, against the World Bank host", async () => {
    const fetchMock = stubWorldBank();
    await fetchWorldBankFacts("MA");
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((u) => u.host)).toEqual(Array(4).fill("api.worldbank.org"));
    expect(urls.map((u) => u.pathname).sort()).toEqual([
      "/v2/country/MA",
      "/v2/country/MA/indicator/FP.CPI.TOTL.ZG",
      "/v2/country/MA/indicator/NY.GDP.MKTP.CD",
      "/v2/country/MA/indicator/SP.POP.TOTL",
    ]);
    for (const url of urls.filter((u) => u.pathname.includes("indicator"))) {
      expect(url.searchParams.get("mrnev")).toBe("1");
    }
  });

  it.each(["ma", "MAR", "M", "", "MA/../x", "MA?x=1"])("refuses %j as a code without fetching", async (code) => {
    const fetchMock = stubWorldBank();
    await expect(fetchWorldBankFacts(code)).rejects.toBeInstanceOf(PanelFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers null, not an error, for a country the API does not know", async () => {
    stubWorldBank({
      country: wbUnknownCountry,
      population: wbUnknownCountry,
      gdp: wbUnknownCountry,
      inflation: wbUnknownCountry,
    });
    await expect(fetchWorldBankFacts("TW")).resolves.toBeNull();
  });

  it("leaves out an indicator with no value at all, keeping the rest", async () => {
    stubWorldBank({ inflation: wbNoData });
    const facts = await fetchWorldBankFacts("MA");
    expect(facts?.inflationPct).toBeNull();
    expect(facts?.population).toEqual({ value: 38430770, year: 2025 });
  });

  it("keeps a negative inflation figure but drops a non-positive population or GDP", async () => {
    stubWorldBank({
      inflation: wbIndicator("FP.CPI.TOTL.ZG", "MA", "2024", -0.3),
      population: wbIndicator("SP.POP.TOTL", "MA", "2024", 0),
      gdp: wbIndicator("NY.GDP.MKTP.CD", "MA", "2024", -5),
    });
    const facts = await fetchWorldBankFacts("MA");
    expect(facts?.inflationPct).toEqual({ value: -0.3, year: 2024 });
    expect(facts?.population).toBeNull();
    expect(facts?.gdpUsd).toBeNull();
  });

  it.each([
    ["an empty capital", ""],
    ["an over-long capital", "x".repeat(81)],
  ])("shows no capital for %s", async (_name, capital) => {
    stubWorldBank({ country: wbCountry("MA", capital) });
    expect((await fetchWorldBankFacts("MA"))?.capital).toBeNull();
  });

  it("answers null when the country row is for another code", async () => {
    stubWorldBank({ country: wbCountry("FR", "Paris") });
    await expect(fetchWorldBankFacts("MA")).resolves.toBeNull();
  });

  it.each([
    ["a different API message", { inflation: [{ message: [{ id: "175", key: "Service unavailable" }] }] }],
    ["an object instead of the [meta, rows] pair", { population: { value: 1 } }],
    ["a string value", { gdp: wbIndicator("NY.GDP.MKTP.CD", "MA", "2024", "big" as unknown as number) }],
    ["a malformed year", { gdp: wbIndicator("NY.GDP.MKTP.CD", "MA", "last year", 1) }],
    ["a country body of the wrong shape", { country: [{}, [{ capitalCity: "Rabat" }]] }],
    ["an HTTP 503 on one indicator", { gdp: jsonResponse({}, { status: 503 }) }],
  ])("throws, rather than answering, on %s", async (_name, answers) => {
    stubWorldBank(answers as Answers);
    await expect(fetchWorldBankFacts("MA")).rejects.toBeInstanceOf(PanelFetchError);
  });
});
