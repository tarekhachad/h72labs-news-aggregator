import "server-only";
import { unstable_cache } from "next/cache";
import { bestEffortLog } from "@/lib/bestEffortLog";
import { fetchTreasuryTenYear, type DatedValue } from "./treasury";
import { fetchExchangeRates, type ExchangeRates } from "./frankfurter";
import { eiaApiKey, fetchOilPrices, type OilPrices } from "./eia";

/** How long the strip's figures are served before the next request refreshes them. */
export const RATES_REVALIDATE_SECONDS = 86_400;
export const RATES_TAG = "panels:rates";

// Next's data cache, shared by every reader and every instance, one entry
// per source: a fetcher that throws stores nothing, so a failure is retried
// by the next request instead of being served for a day, and a refresh that
// fails keeps serving the last good copy. Each wrapper takes no arguments,
// so the EIA key never becomes part of a cache key.
const cachedTreasury = unstable_cache(() => fetchTreasuryTenYear(), ["panels", "rates", "treasury", "v1"], {
  revalidate: RATES_REVALIDATE_SECONDS,
  tags: [RATES_TAG],
});
const cachedFrankfurter = unstable_cache(() => fetchExchangeRates(), ["panels", "rates", "frankfurter", "v1"], {
  revalidate: RATES_REVALIDATE_SECONDS,
  tags: [RATES_TAG],
});
const cachedEia = unstable_cache(() => fetchOilPrices(), ["panels", "rates", "eia", "v1"], {
  revalidate: RATES_REVALIDATE_SECONDS,
  tags: [RATES_TAG],
});

export type RatesStripData = {
  tenYear: DatedValue | null;
  fx: ExchangeRates | null;
  oil: OilPrices | null;
};

let missingKeyLogged = false;

async function oilIfConfigured(): Promise<OilPrices | null> {
  // No key is a deployment choice, not a failure: no request, nothing
  // cached, and one line per process rather than one per page view.
  if (!eiaApiKey()) {
    if (!missingKeyLogged) {
      missingKeyLogged = true;
      bestEffortLog("log", "[panels] EIA_API_KEY is not set: the rates strip shows no oil prices");
    }
    return null;
  }
  return cachedEia();
}

/**
 * The Markets & Investing strip's figures, or null when every source failed.
 * A source that fails is left out, so the strip shows whatever came back.
 * Never throws.
 */
export async function getRatesStrip(): Promise<RatesStripData | null> {
  const [tenYear, fx, oil] = await Promise.allSettled([cachedTreasury(), cachedFrankfurter(), oilIfConfigured()]);
  for (const [source, result] of [
    ["Treasury", tenYear],
    ["Frankfurter", fx],
    ["EIA", oil],
  ] as const) {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : "unknown error";
      bestEffortLog("warn", `[panels] ${source} rates unavailable: ${reason}`);
    }
  }

  const data: RatesStripData = {
    tenYear: tenYear.status === "fulfilled" ? tenYear.value : null,
    fx: fx.status === "fulfilled" ? fx.value : null,
    oil: oil.status === "fulfilled" ? oil.value : null,
  };
  if (!data.tenYear && !data.fx && !data.oil?.brent && !data.oil?.wti) return null;
  return data;
}
