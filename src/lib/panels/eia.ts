import "server-only";
import { z } from "zod";
import { fetchCappedJson, PanelFetchError } from "./fetchJson";
import { isIsoDay } from "./isoDay";
import type { DatedValue } from "./treasury";

export type OilPrices = {
  /** Europe Brent spot price FOB, dollars per barrel. */
  brent: DatedValue | null;
  /** Cushing, OK WTI spot price FOB, dollars per barrel. */
  wti: DatedValue | null;
};

/** EIA's series ids for the two spot prices. */
export const EIA_SERIES = { brent: "RBRTE", wti: "RWTC" } as const;

// Newest first, both series interleaved: twenty rows reach back about ten
// trading days, so one series missing a day (a UK or US holiday) still finds
// its latest value. Brackets are left literal, as the API documents them.
const URL_ =
  "https://api.eia.gov/v2/petroleum/pri/spt/data/?frequency=daily&data[0]=value" +
  `&facets[series][]=${EIA_SERIES.brent}&facets[series][]=${EIA_SERIES.wti}` +
  "&sort[0][column]=period&sort[0][direction]=desc&length=20";
const MAX_BYTES = 64 * 1024;
// An uncached answer took 20 s when measured.
export const EIA_TIMEOUT_MS = 25_000;

// The API sends numbers as strings ("96.24"), and also sends a spurious
// "incomplete return" warning whenever the series' total row count is over
// 5,000, however few rows were asked for; the warning is ignored.
const responseBody = z
  .object({
    response: z
      .object({
        data: z
          .array(
            z
              .object({
                period: z.string(),
                series: z.string(),
                value: z.union([z.string(), z.number(), z.null()]),
              })
              .loose()
          )
          .max(100),
      })
      .loose(),
  })
  .loose();

const NUMBER = /^-?\d{1,4}(?:\.\d{1,4})?$/;

function toPrice(value: string | number | null): number | null {
  if (value === null) return null;
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!NUMBER.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Each series' latest usable price; throws PanelFetchError on any other answer, or when neither series has one. */
export function parseOilPrices(body: unknown): OilPrices {
  const parsed = responseBody.safeParse(body);
  if (!parsed.success) throw new PanelFetchError("EIA body has an unexpected shape");
  const latest = (series: string): DatedValue | null => {
    let best: DatedValue | null = null;
    for (const row of parsed.data.response.data) {
      if (row.series !== series || !isIsoDay(row.period)) continue;
      const value = toPrice(row.value);
      if (value === null) continue;
      if (!best || row.period > best.date) best = { value, date: row.period };
    }
    return best;
  };
  const prices = { brent: latest(EIA_SERIES.brent), wti: latest(EIA_SERIES.wti) };
  if (!prices.brent && !prices.wti) throw new PanelFetchError("EIA answer has no Brent or WTI price");
  return prices;
}

/** The EIA key, or null when this deployment has none. */
export function eiaApiKey(): string | null {
  const key = process.env.EIA_API_KEY?.trim();
  return key ? key : null;
}

/**
 * Brent and WTI daily spot prices from the EIA API v2 (public domain).
 * Daily prices are released weekly, so each carries its own day, often a
 * week old. The key travels in a header, never in the URL, so it cannot
 * reach a log line or an error message. Callers check eiaApiKey() first;
 * called without one this throws. Throws PanelFetchError on any failure.
 */
export async function fetchOilPrices(): Promise<OilPrices> {
  const key = eiaApiKey();
  if (!key) throw new PanelFetchError("no EIA API key");
  const body = await fetchCappedJson(URL_, {
    maxBytes: MAX_BYTES,
    timeoutMs: EIA_TIMEOUT_MS,
    headers: { "X-Api-Key": key },
  });
  return parseOilPrices(body);
}
