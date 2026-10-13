import "server-only";
import { z } from "zod";
import { fetchCappedJson, PanelFetchError } from "./fetchJson";

/** A Wikidata item: its Q-id and English label. */
export type WikidataItem = { id: string; label: string };

export type WikidataFacts = {
  /** Q-id of the item the code resolved to, for the credit link. */
  entity: string;
  /** UTC day the values were read (YYYY-MM-DD): Wikidata's values carry no year of their own. */
  retrievedOn: string;
  currency: WikidataItem[];
  headOfState: WikidataItem[];
  headOfGovernment: WikidataItem[];
};

const ENDPOINT = "https://query.wikidata.org/sparql";
const MAX_BYTES = 128 * 1024;
const MAX_ROWS = 200;
const MAX_LABEL_LENGTH = 100;
/**
 * More current values than this reads as a list the box cannot state
 * plainly, so it shows none: the Kingdom of the Netherlands, which holds the
 * code NL, lists four currencies across its constituent countries.
 */
export const MAX_VALUES_PER_FACT = 2;

const ISO2 = /^[A-Z]{2}$/;
const ITEM_URI = /^http:\/\/www\.wikidata\.org\/entity\/(Q[1-9]\d{0,11})$/;
const PREFERRED = "http://wikiba.se/ontology#PreferredRank";
const NORMAL = "http://wikiba.se/ontology#NormalRank";
const FACTS = ["currency", "headOfState", "headOfGovernment"] as const;
type Fact = (typeof FACTS)[number];

/**
 * Current statements only: deprecated ones are dropped here, ended ones
 * (an end time, P582) in the query. Each filter sits inside its own UNION
 * branch on purpose: hoisted out of the branches, the query planner scans
 * every statement in Wikidata and the query times out.
 */
export function buildQuery(code: string): string {
  if (!ISO2.test(code)) throw new PanelFetchError("not an ISO 3166-1 alpha-2 code");
  const branch = (fact: Fact, property: string) =>
    `{ ?c p:${property} ?st . ?st ps:${property} ?value ; wikibase:rank ?rank . ` +
    `FILTER NOT EXISTS { ?st pq:P582 [] } BIND("${fact}" AS ?prop) }`;
  return [
    "SELECT ?c ?links ?prop ?value ?valueLabel ?rank WHERE {",
    `  ?c wdt:P297 "${code}" ; wikibase:sitelinks ?links .`,
    `  ${branch("currency", "P38")}`,
    `  UNION ${branch("headOfState", "P35")}`,
    `  UNION ${branch("headOfGovernment", "P6")}`,
    '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }',
    "}",
  ].join("\n");
}

const term = z.object({ type: z.string(), value: z.string(), "xml:lang": z.string().optional() }).loose();
const responseBody = z
  .object({
    results: z.object({
      bindings: z
        .array(
          z
            .object({
              c: term,
              links: term,
              prop: term,
              value: term,
              valueLabel: term.optional(),
              rank: term,
            })
            .loose()
        )
        .max(MAX_ROWS),
    }),
  })
  .loose();

type Row = {
  entity: string;
  links: number;
  fact: Fact;
  value: string;
  /** The label service found an English label, usable or not. */
  labelled: boolean;
  label: string | null;
  preferred: boolean;
};

function toRow(binding: z.infer<typeof responseBody>["results"]["bindings"][number]): Row | null {
  const entity = ITEM_URI.exec(binding.c.value)?.[1];
  const value = binding.value.type === "uri" ? ITEM_URI.exec(binding.value.value)?.[1] : undefined;
  const fact = FACTS.find((f) => f === binding.prop.value);
  const links = Number(binding.links.value);
  const rank = binding.rank.value;
  // An "unknown value" statement comes back as a blank node, not an item.
  if (!entity || !value || !fact || !Number.isSafeInteger(links)) return null;
  if (rank !== PREFERRED && rank !== NORMAL) return null;
  // The label service falls back to the bare Q-id, with no language tag,
  // when an item has no English label.
  const labelTerm = binding.valueLabel;
  const labelled = Boolean(labelTerm?.["xml:lang"]);
  const text = labelled ? labelTerm!.value.trim() : "";
  const label = text.length > 0 && text.length <= MAX_LABEL_LENGTH ? text : null;
  return { entity, links, fact, value, labelled, label, preferred: rank === PREFERRED };
}

/** Preferred statements win when there are any, as Wikidata's own "best rank" rule does. */
function current(rows: Row[], fact: Fact): WikidataItem[] {
  const forFact = rows.filter((r) => r.fact === fact);
  const best = forFact.some((r) => r.preferred) ? forFact.filter((r) => r.preferred) : forFact;
  const byValue = new Map<string, string | null>();
  for (const row of best) {
    if (!byValue.has(row.value) || byValue.get(row.value) === null) byValue.set(row.value, row.label);
  }
  if (byValue.size > MAX_VALUES_PER_FACT) return [];
  return [...byValue].flatMap(([id, label]) => (label === null ? [] : [{ id, label }]));
}

function qNumber(id: string): number {
  return Number(id.slice(1));
}

export function parseWikidataResponse(body: unknown, retrievedOn: string): WikidataFacts | null {
  const parsed = responseBody.safeParse(body);
  if (!parsed.success) throw new PanelFetchError("Wikidata body has an unexpected shape");
  const rows = parsed.data.results.bindings.map(toRow).filter((r): r is Row => r !== null);
  if (rows.length === 0) return null;
  // Every country's currency and leaders have English labels, so an answer
  // with none at all means the label service failed. Thrown rather than
  // returned, so a day of empty facts is never cached.
  if (rows.every((r) => !r.labelled)) throw new PanelFetchError("Wikidata answer carries no English labels");

  // Two items can share a code (a state and a historical or constituent
  // one). The most widely linked is the one readers mean; the older Q-id
  // breaks a tie, so the choice never flips between refreshes.
  const entity = rows.reduce((best, r) =>
    r.links > best.links || (r.links === best.links && qNumber(r.entity) < qNumber(best.entity)) ? r : best
  ).entity;
  const own = rows.filter((r) => r.entity === entity);
  return {
    entity,
    retrievedOn,
    currency: current(own, "currency"),
    headOfState: current(own, "headOfState"),
    headOfGovernment: current(own, "headOfGovernment"),
  };
}

/**
 * One country's currency, head of state and head of government from
 * Wikidata (CC0), looked up by its ISO 3166-1 alpha-2 code (P297). Returns
 * null when no item carries the code or none of its statements are usable
 * (an answer worth caching); throws PanelFetchError on any failure.
 */
export async function fetchWikidataFacts(code: string): Promise<WikidataFacts | null> {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(buildQuery(code))}`;
  const body = await fetchCappedJson(url, { maxBytes: MAX_BYTES, accept: "application/sparql-results+json" });
  return parseWikidataResponse(body, new Date().toISOString().slice(0, 10));
}
