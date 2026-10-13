import { getCountryFacts } from "@/lib/panels/countryFacts";
import { CountryFactsBox } from "./CountryFactsBox";

/**
 * The Countries page's panel when one country is filtered. Async: on a cache
 * miss it waits on the World Bank and Wikidata, so it must sit inside the
 * topic page's Suspense slot. No facts, no box.
 */
export async function CountryFactsPanel({ country }: { country: string }) {
  const facts = await getCountryFacts(country);
  return facts ? <CountryFactsBox facts={facts} /> : null;
}
