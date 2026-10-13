// Country names only, with no feed URLs, so browser code can import it: the
// pickers and the Countries page need the names, and nothing in the browser
// may carry COUNTRY_FEEDS (src/config/countries.ts). The client-graph guard
// in src/lib/__tests__/sourceCoverage.clientGraph.test.ts enforces the split.

/**
 * The Countries topic: a reader picks countries inside it, and each picked
 * country is its own reading unit (src/lib/readingUnits.ts), with its own feed
 * slots and card limit. Only a country with at least 3 live-verified feeds is
 * offered, the same rule as topics.
 */
export const COUNTRIES_TOPIC = "Countries" as const;

/** Offered countries, in the order the picker lists them and a digest reads them. */
export const COUNTRIES: readonly string[] = [
  "Afghanistan",
  "Algeria",
  "Argentina",
  "Australia",
  "Austria",
  "Bangladesh",
  "Botswana",
  "Brazil",
  "Bulgaria",
  "Burkina Faso",
  "Cambodia",
  "Cameroon",
  "Canada",
  "Chile",
  "China",
  "Costa Rica",
  "Côte d'Ivoire",
  "Croatia",
  "Cuba",
  "Cyprus",
  "Czech Republic",
  "Denmark",
  "Dominican Republic",
  "DR Congo",
  "Egypt",
  "Ethiopia",
  "Finland",
  "France",
  "Germany",
  "Ghana",
  "Greece",
  "Guatemala",
  "Hong Kong",
  "Hungary",
  "Iceland",
  "India",
  "Indonesia",
  "Iran",
  "Iraq",
  "Ireland",
  "Israel",
  "Italy",
  "Japan",
  "Jordan",
  "Kazakhstan",
  "Kenya",
  "Latvia",
  "Lebanon",
  "Libya",
  "Malaysia",
  "Mali",
  "Malta",
  "Mexico",
  "Morocco",
  "Mozambique",
  "Myanmar",
  "Namibia",
  "Nepal",
  "New Zealand",
  "Nicaragua",
  "Nigeria",
  "North Korea",
  "Norway",
  "Pakistan",
  "Palestine",
  "Panama",
  "Peru",
  "Philippines",
  "Poland",
  "Portugal",
  "Puerto Rico",
  "Romania",
  "Russia",
  "Rwanda",
  "Senegal",
  "Serbia",
  "Singapore",
  "Slovakia",
  "South Africa",
  "South Korea",
  "Spain",
  "Sudan",
  "Sweden",
  "Switzerland",
  "Syria",
  "Tanzania",
  "Thailand",
  "The Gambia",
  "Tunisia",
  "Turkey",
  "Uganda",
  "Ukraine",
  "United Kingdom",
  "United States",
  "Uruguay",
  "Uzbekistan",
  "Venezuela",
  "Zambia",
  "Zimbabwe",
];

/** URL-safe form of a country name, for the Countries page filter. */
export function countryToSlug(country: string): string {
  return country
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The offered country a slug names, or null. */
export function slugToCountry(slug: string): string | null {
  return COUNTRIES.find((country) => countryToSlug(country) === slug) ?? null;
}
