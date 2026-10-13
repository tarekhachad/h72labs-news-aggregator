// Response bodies shaped after live answers from api.worldbank.org and
// query.wikidata.org, read 2026-10-13. Values are trimmed; shapes are not.

export const wbMeta = { page: 1, pages: 1, per_page: 50, total: 1, sourceid: null, lastupdated: "2026-10-08" };

export function wbIndicator(id: string, iso2: string, date: string, value: number | null) {
  return [
    wbMeta,
    [
      {
        indicator: { id, value: "Indicator name" },
        country: { id: iso2, value: "Morocco" },
        countryiso3code: "MAR",
        date,
        value,
        obs_status: "",
        decimal: 0,
      },
    ],
  ];
}

/** `mrnev=1` for a country with no value at all. */
export const wbNoData = [{ page: 0, pages: 0, per_page: 0, total: 0, sourceid: null, lastupdated: null }, null];

/** The API's answer to an unknown country code: HTTP 200, not a 4xx. */
export const wbUnknownCountry = [
  { message: [{ id: "120", key: "Invalid value", value: "The provided parameter value is not valid" }] },
];

export function wbCountry(iso2: string, capitalCity: string) {
  return [
    { page: 1, pages: 1, per_page: "50", total: 1 },
    [
      {
        id: "MAR",
        iso2Code: iso2,
        name: "Morocco",
        region: { id: "MEA", iso2code: "ZQ", value: "Middle East, North Africa, Afghanistan & Pakistan" },
        capitalCity,
        longitude: "-6.8704",
        latitude: "33.9905",
      },
    ],
  ];
}

type Binding = {
  entity?: string;
  links?: number;
  prop: "currency" | "headOfState" | "headOfGovernment";
  value: string;
  label?: string | null;
  rank?: "Preferred" | "Normal";
  valueType?: string;
};

export function wdBinding({ entity = "Q1028", links = 300, prop, value, label, rank = "Preferred", valueType = "uri" }: Binding) {
  return {
    c: { type: "uri", value: `http://www.wikidata.org/entity/${entity}` },
    links: { datatype: "http://www.w3.org/2001/XMLSchema#integer", type: "literal", value: String(links) },
    prop: { type: "literal", value: prop },
    value: { type: valueType, value: valueType === "uri" ? `http://www.wikidata.org/entity/${value}` : value },
    // The label service answers the bare Q-id, untagged, when an item has no English label.
    valueLabel:
      label === null
        ? { type: "literal", value }
        : { "xml:lang": "en", type: "literal", value: label ?? `Label of ${value}` },
    rank: { type: "uri", value: `http://wikiba.se/ontology#${rank}Rank` },
  };
}

export function wdBody(bindings: unknown[]) {
  return { head: { vars: ["c", "links", "prop", "value", "valueLabel", "rank"] }, results: { bindings } };
}

/** Morocco: one currency, a king, a prime minister. */
export const wdMorocco = wdBody([
  wdBinding({ prop: "currency", value: "Q200192", label: "Moroccan dirham" }),
  wdBinding({ prop: "headOfState", value: "Q57553", label: "Mohammed VI of Morocco" }),
  wdBinding({ prop: "headOfGovernment", value: "Q3378813", label: "Aziz Akhannouch" }),
]);

/** The Kingdom of the Netherlands, which holds NL: four currencies, one unlabeled. */
export const wdNetherlands = wdBody([
  wdBinding({ entity: "Q29999", links: 107, prop: "headOfState", value: "Q154952", label: "William Alexander of the Netherlands" }),
  wdBinding({ entity: "Q29999", links: 107, prop: "headOfGovernment", value: "Q28860866", label: "Rob Jetten" }),
  wdBinding({ entity: "Q29999", links: 107, prop: "currency", value: "Q232270", label: "Aruban florin" }),
  wdBinding({ entity: "Q29999", links: 107, prop: "currency", value: "Q4916", label: null }),
  wdBinding({ entity: "Q29999", links: 107, prop: "currency", value: "Q4917", label: "United States dollar" }),
  wdBinding({ entity: "Q29999", links: 107, prop: "currency", value: "Q737779", label: "Caribbean guilder" }),
]);

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}
