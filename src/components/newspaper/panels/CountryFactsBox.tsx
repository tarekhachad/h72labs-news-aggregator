import type { CountryFacts } from "@/lib/panels/countryFacts";
import type { WikidataItem } from "@/lib/panels/wikidata";
import { formatPercent, formatPopulation, formatUsd } from "@/lib/panels/format";
import { PanelBand } from "./PanelBand";

const WORLD_BANK_DATASET = "https://datacatalog.worldbank.org/search/dataset/0037712/World-Development-Indicators";
const CC_BY_4 = "https://creativecommons.org/licenses/by/4.0/";

type Fact = { label: string; value: string; from: "worldBank" | "wikidata"; source: string };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function names(items: readonly WikidataItem[]): string {
  return items.map((item) => item.label).join(" and ");
}

function sameItems(a: readonly WikidataItem[], b: readonly WikidataItem[]): boolean {
  const ids = new Set(a.map((item) => item.id));
  return a.length > 0 && a.length === b.length && b.every((item) => ids.has(item.id));
}

/** "Wikidata, as of Oct 13, 2026"; plain "Wikidata" if the stored day does not parse, rather than throwing mid-render. */
function wikidataSourceLine(retrievedOn: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(retrievedOn) ? new Date(`${retrievedOn}T00:00:00Z`) : null;
  return day && !Number.isNaN(day.getTime()) ? `Wikidata, as of ${DATE.format(day)}` : "Wikidata";
}

function factsFor({ worldBank, wikidata }: CountryFacts): Fact[] {
  const facts: Fact[] = [];
  const wikidataSource = wikidata ? wikidataSourceLine(wikidata.retrievedOn) : "";

  if (worldBank?.capital) facts.push({ label: "Capital", value: worldBank.capital, from: "worldBank", source: "World Bank" });
  if (wikidata && wikidata.currency.length > 0) {
    facts.push({ label: "Currency", value: names(wikidata.currency), from: "wikidata", source: wikidataSource });
  }
  if (worldBank?.population) {
    facts.push({ label: "Population", value: formatPopulation(worldBank.population), from: "worldBank", source: "World Bank" });
  }
  if (worldBank?.gdpUsd) facts.push({ label: "GDP", value: formatUsd(worldBank.gdpUsd), from: "worldBank", source: "World Bank" });
  if (worldBank?.inflationPct) {
    facts.push({ label: "Inflation", value: formatPercent(worldBank.inflationPct), from: "worldBank", source: "World Bank" });
  }
  if (wikidata) {
    const { headOfState, headOfGovernment } = wikidata;
    if (sameItems(headOfState, headOfGovernment)) {
      facts.push({ label: "Head of state and government", value: names(headOfState), from: "wikidata", source: wikidataSource });
    } else {
      if (headOfState.length > 0) {
        facts.push({ label: "Head of state", value: names(headOfState), from: "wikidata", source: wikidataSource });
      }
      if (headOfGovernment.length > 0) {
        facts.push({ label: "Head of government", value: names(headOfGovernment), from: "wikidata", source: wikidataSource });
      }
    }
  }
  return facts;
}

/**
 * The Countries page's fact box for the filtered country. Every upstream
 * string is rendered as React text, never as HTML. Credits only the sources
 * that supplied a fact shown.
 */
export function CountryFactsBox({ facts }: { facts: CountryFacts }) {
  const shown = factsFor(facts);
  if (shown.length === 0) return null;
  const usesWorldBank = shown.some((fact) => fact.from === "worldBank");
  const wikidataEntity = shown.some((fact) => fact.from === "wikidata") ? facts.wikidata?.entity : undefined;
  const heading = `${facts.country} at a glance`;

  return (
    <PanelBand label={heading}>
      <div className="border-y py-4" style={{ borderColor: "var(--color-rule)" }}>
        <h2 className="mb-3 font-heading text-lg font-semibold">{heading}</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((fact) => (
            <div key={fact.label}>
              <dt className="text-xs uppercase tracking-wide" style={{ color: "var(--color-muted-foreground)" }}>
                {fact.label}
              </dt>
              <dd className="text-sm font-semibold">{fact.value}</dd>
              <dd className="text-xs" style={{ color: "var(--color-muted-foreground)" }}>
                {fact.source}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs" style={{ color: "var(--color-muted-foreground)" }}>
          {usesWorldBank && (
            <>
              Source:{" "}
              <a href={WORLD_BANK_DATASET} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer">
                World Bank, World Development Indicators
              </a>{" "}
              (
              <a href={CC_BY_4} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer">
                CC BY 4.0
              </a>
              ), figures rounded.{" "}
            </>
          )}
          {wikidataEntity && (
            <>
              Currency and leaders:{" "}
              <a
                href={`https://www.wikidata.org/wiki/${wikidataEntity}`}
                className="underline underline-offset-2"
                target="_blank"
                rel="noopener noreferrer"
              >
                Wikidata
              </a>{" "}
              (CC0), edited by volunteers.
            </>
          )}
        </p>
      </div>
    </PanelBand>
  );
}
