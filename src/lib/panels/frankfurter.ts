import "server-only";
import { z } from "zod";
import { fetchCappedJson, PanelFetchError } from "./fetchJson";
import { isIsoDay } from "./isoDay";
import type { DatedValue } from "./treasury";

export type ExchangeRates = {
  /** US dollars per euro. */
  eurUsd: DatedValue;
  /** Moroccan dirhams per US dollar. */
  usdMad: DatedValue;
};

const API = "https://api.frankfurter.dev/v2/rate";
// One pair's answer is about 60 bytes.
const MAX_BYTES = 4 * 1024;
// An uncached pair took 7 s to answer when measured.
export const FRANKFURTER_TIMEOUT_MS = 15_000;

const PAIRS = { eurUsd: ["EUR", "USD"], usdMad: ["USD", "MAD"] } as const;

function pairBody(base: string, quote: string) {
  return z
    .object({
      date: z.string().refine(isIsoDay),
      base: z.literal(base),
      quote: z.literal(quote),
      rate: z.number().finite().positive(),
    })
    .loose();
}

/** One pair's rate and its day; throws PanelFetchError on any other answer. */
export function parsePair(body: unknown, base: string, quote: string): DatedValue {
  const parsed = pairBody(base, quote).safeParse(body);
  if (!parsed.success) throw new PanelFetchError(`Frankfurter ${base}/${quote} body has an unexpected shape`);
  return { value: parsed.data.rate, date: parsed.data.date };
}

/**
 * EUR/USD and USD/MAD from Frankfurter's blended daily rates (free for
 * commercial use, no key). The two pairs can carry different days: each
 * blends whichever providers have published. Both or neither: throws
 * PanelFetchError if either pair fails, so a half answer is never cached.
 */
export async function fetchExchangeRates(): Promise<ExchangeRates> {
  const [eurUsd, usdMad] = await Promise.all(
    [PAIRS.eurUsd, PAIRS.usdMad].map(async ([base, quote]) =>
      parsePair(
        await fetchCappedJson(`${API}/${base}/${quote}`, { maxBytes: MAX_BYTES, timeoutMs: FRANKFURTER_TIMEOUT_MS }),
        base,
        quote
      )
    )
  );
  return { eurUsd, usdMad };
}
