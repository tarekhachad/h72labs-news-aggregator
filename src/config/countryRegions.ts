import { COUNTRIES } from "@/config/countries";

/**
 * The five regions the countries picker groups its list under, each country
 * in exactly one (src/config/__tests__/countryRegions.test.ts holds this to
 * COUNTRIES). Regions follow the continent, with the Middle East as West
 * Asia: North Africa, Egypt included, sits with Africa, and Turkey and
 * Cyprus with Europe. Central and South Asia are in Asia-Pacific.
 */
export const COUNTRY_REGIONS: readonly { name: string; countries: readonly string[] }[] = [
  {
    name: "Africa",
    countries: [
      "Algeria",
      "Botswana",
      "Burkina Faso",
      "Cameroon",
      "Côte d'Ivoire",
      "DR Congo",
      "Egypt",
      "Ethiopia",
      "Ghana",
      "Kenya",
      "Libya",
      "Mali",
      "Morocco",
      "Mozambique",
      "Namibia",
      "Nigeria",
      "Rwanda",
      "Senegal",
      "South Africa",
      "Sudan",
      "Tanzania",
      "The Gambia",
      "Tunisia",
      "Uganda",
      "Zambia",
      "Zimbabwe",
    ],
  },
  {
    name: "Americas",
    countries: [
      "Argentina",
      "Brazil",
      "Canada",
      "Chile",
      "Costa Rica",
      "Cuba",
      "Dominican Republic",
      "Guatemala",
      "Mexico",
      "Nicaragua",
      "Panama",
      "Peru",
      "Puerto Rico",
      "United States",
      "Uruguay",
      "Venezuela",
    ],
  },
  {
    name: "Asia-Pacific",
    countries: [
      "Afghanistan",
      "Australia",
      "Bangladesh",
      "Cambodia",
      "China",
      "Hong Kong",
      "India",
      "Indonesia",
      "Japan",
      "Kazakhstan",
      "Malaysia",
      "Myanmar",
      "Nepal",
      "New Zealand",
      "North Korea",
      "Pakistan",
      "Philippines",
      "Singapore",
      "South Korea",
      "Thailand",
      "Uzbekistan",
    ],
  },
  {
    name: "Europe",
    countries: [
      "Austria",
      "Bulgaria",
      "Croatia",
      "Cyprus",
      "Czech Republic",
      "Denmark",
      "Finland",
      "France",
      "Germany",
      "Greece",
      "Hungary",
      "Iceland",
      "Ireland",
      "Italy",
      "Latvia",
      "Malta",
      "Norway",
      "Poland",
      "Portugal",
      "Romania",
      "Russia",
      "Serbia",
      "Slovakia",
      "Spain",
      "Sweden",
      "Switzerland",
      "Turkey",
      "Ukraine",
      "United Kingdom",
    ],
  },
  {
    name: "Middle East",
    countries: ["Iran", "Iraq", "Israel", "Jordan", "Lebanon", "Palestine", "Syria"],
  },
];

/**
 * The offered countries under their regions, for a grouped picker: each
 * region's countries in COUNTRIES order, and a region with none left out.
 */
export function countriesByRegion(): { label: string; items: string[] }[] {
  return COUNTRY_REGIONS.map((region) => {
    const members = new Set(region.countries);
    return { label: region.name, items: COUNTRIES.filter((country) => members.has(country)) };
  }).filter((group) => group.items.length > 0);
}
