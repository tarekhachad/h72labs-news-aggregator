import "server-only";
import { z } from "zod";
import { fetchCappedJson, PanelFetchError } from "./fetchJson";

/** A yearly figure and the year it describes. */
export type YearValue = { value: number; year: number };

export type WorldBankFacts = {
  capital: string | null;
  population: YearValue | null;
  /** GDP in current US dollars. */
  gdpUsd: YearValue | null;
  /** Inflation, consumer prices, annual %. */
  inflationPct: YearValue | null;
};

/** The World Development Indicators the box shows (CC BY 4.0). */
export const WORLD_BANK_INDICATORS = {
  population: "SP.POP.TOTL",
  gdpUsd: "NY.GDP.MKTP.CD",
  inflationPct: "FP.CPI.TOTL.ZG",
} as const;

const API = "https://api.worldbank.org/v2/country";
// A one-country answer is well under 1 KB; anything near this is not one.
const MAX_BYTES = 64 * 1024;
const MAX_CAPITAL_LENGTH = 80;
const ISO2 = /^[A-Z]{2}$/;

// The API answers an unknown country code with HTTP 200 and this body, not
// a 4xx. Its "Invalid value" id is the only message read as "no such
// country"; any other message is a failure.
const UNKNOWN_COUNTRY_ID = "120";
const messageBody = z.tuple([
  z.object({ message: z.array(z.object({ id: z.string() }).loose()).min(1) }).loose(),
]);

// `mrnev=1` asks for the most recent non-empty value. A country with no
// value at all comes back as `[meta, null]`.
const indicatorBody = z.tuple([
  z.object({ total: z.number() }).loose(),
  z
    .array(
      z
        .object({
          date: z.string().regex(/^\d{4}$/),
          value: z.number().finite().nullable(),
        })
        .loose()
    )
    .max(10)
    .nullable(),
]);

const countryBody = z.tuple([
  z.object({}).loose(),
  z
    .array(z.object({ iso2Code: z.string(), capitalCity: z.string().optional() }).loose())
    .max(5)
    .nullable(),
]);

function isUnknownCountry(body: unknown): boolean {
  const parsed = messageBody.safeParse(body);
  if (!parsed.success) return false;
  if (parsed.data[0].message.every((m) => m.id === UNKNOWN_COUNTRY_ID)) return true;
  throw new PanelFetchError(`World Bank error message ${parsed.data[0].message[0].id}`);
}

function parseIndicator(body: unknown, positive: boolean): YearValue | null {
  if (isUnknownCountry(body)) return null;
  const parsed = indicatorBody.safeParse(body);
  if (!parsed.success) throw new PanelFetchError("World Bank indicator body has an unexpected shape");
  const row = parsed.data[1]?.find((r) => r.value !== null);
  if (!row || row.value === null) return null;
  if (positive && row.value <= 0) return null;
  return { value: row.value, year: Number(row.date) };
}

/** null: the API does not know this country code. */
function parseCountry(body: unknown, code: string): { capital: string | null } | null {
  if (isUnknownCountry(body)) return null;
  const parsed = countryBody.safeParse(body);
  if (!parsed.success) throw new PanelFetchError("World Bank country body has an unexpected shape");
  const row = parsed.data[1]?.find((r) => r.iso2Code === code);
  if (!row) return null;
  const capital = row.capitalCity?.trim() ?? "";
  return { capital: capital.length > 0 && capital.length <= MAX_CAPITAL_LENGTH ? capital : null };
}

/**
 * One country's capital, population, GDP and inflation from the World Bank
 * Indicators API, each figure its most recent non-empty year. Returns null
 * when the API does not know the country (an answer worth caching); throws
 * PanelFetchError on any failure, so a failure is never cached as data.
 */
export async function fetchWorldBankFacts(code: string): Promise<WorldBankFacts | null> {
  if (!ISO2.test(code)) throw new PanelFetchError("not an ISO 3166-1 alpha-2 code");

  const indicatorUrl = (id: string) => `${API}/${code}/indicator/${id}?format=json&mrnev=1`;
  const [country, population, gdpUsd, inflationPct] = await Promise.all([
    fetchCappedJson(`${API}/${code}?format=json`, { maxBytes: MAX_BYTES }),
    fetchCappedJson(indicatorUrl(WORLD_BANK_INDICATORS.population), { maxBytes: MAX_BYTES }),
    fetchCappedJson(indicatorUrl(WORLD_BANK_INDICATORS.gdpUsd), { maxBytes: MAX_BYTES }),
    fetchCappedJson(indicatorUrl(WORLD_BANK_INDICATORS.inflationPct), { maxBytes: MAX_BYTES }),
  ]);

  const known = parseCountry(country, code);
  if (!known) return null;
  return {
    capital: known.capital,
    population: parseIndicator(population, true),
    gdpUsd: parseIndicator(gdpUsd, true),
    inflationPct: parseIndicator(inflationPct, false),
  };
}
