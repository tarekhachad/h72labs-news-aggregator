import "server-only";
import { unstable_cache } from "next/cache";
import { countryCode } from "@/config/countryCodes";
import { bestEffortLog } from "@/lib/bestEffortLog";
import { fetchWorldBankFacts, type WorldBankFacts } from "./worldBank";
import { fetchWikidataFacts, type WikidataFacts } from "./wikidata";

/** How long a country's facts are served before the next request refreshes them. */
export const COUNTRY_FACTS_REVALIDATE_SECONDS = 86_400;
export const COUNTRY_FACTS_TAG = "panels:country-facts";

// Next's data cache, shared by every reader and every instance. Only a value
// the fetcher returns is stored: a fetcher that throws stores nothing, so a
// failed fetch is retried by the next request instead of being served for a
// day, and a refresh that fails keeps serving the last good copy. One cache
// entry per source, so one source failing never discards the other's answer.
const cachedWorldBank = unstable_cache(fetchWorldBankFacts, ["panels", "country-facts", "world-bank", "v1"], {
  revalidate: COUNTRY_FACTS_REVALIDATE_SECONDS,
  tags: [COUNTRY_FACTS_TAG],
});
const cachedWikidata = unstable_cache(fetchWikidataFacts, ["panels", "country-facts", "wikidata", "v1"], {
  revalidate: COUNTRY_FACTS_REVALIDATE_SECONDS,
  tags: [COUNTRY_FACTS_TAG],
});

export type CountryFacts = {
  country: string;
  worldBank: WorldBankFacts | null;
  wikidata: WikidataFacts | null;
};

function hasWorldBankFact(facts: WorldBankFacts | null): boolean {
  return Boolean(facts && (facts.capital || facts.population || facts.gdpUsd || facts.inflationPct));
}

function hasWikidataFact(facts: WikidataFacts | null): boolean {
  return Boolean(
    facts && (facts.currency.length || facts.headOfState.length || facts.headOfGovernment.length)
  );
}

/**
 * The fact box's data for one of COUNTRIES, or null when there is nothing
 * to show: a name without an ISO code, a country neither source knows, or
 * both sources failing. A source that fails or knows nothing is simply left
 * out, so the box shows whatever came back. Never throws.
 */
export async function getCountryFacts(country: string): Promise<CountryFacts | null> {
  const code = countryCode(country);
  if (!code) return null;

  const [worldBank, wikidata] = await Promise.allSettled([cachedWorldBank(code), cachedWikidata(code)]);
  for (const [source, result] of [
    ["World Bank", worldBank],
    ["Wikidata", wikidata],
  ] as const) {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : "unknown error";
      bestEffortLog("warn", `[panels] ${source} facts for ${code} unavailable: ${reason}`);
    }
  }

  const facts: CountryFacts = {
    country,
    worldBank: worldBank.status === "fulfilled" ? worldBank.value : null,
    wikidata: wikidata.status === "fulfilled" ? wikidata.value : null,
  };
  if (!hasWorldBankFact(facts.worldBank) && !hasWikidataFact(facts.wikidata)) return null;
  return facts;
}
