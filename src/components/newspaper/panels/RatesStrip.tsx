import type { RatesStripData } from "@/lib/panels/rates";
import type { DatedValue } from "@/lib/panels/treasury";
import { formatDay, formatFxRate, formatOilPrice, formatYield } from "@/lib/panels/format";
import { PanelBand } from "./PanelBand";

export const RATES_STRIP_TITLE = "Rates & commodities";

type Source = "treasury" | "frankfurter" | "eia";
type Figure = { label: string; value: string; unit?: string; asOf: string; from: Source };

const CREDITS: readonly { from: Source; prefix: string; name: string; href: string }[] = [
  {
    from: "treasury",
    prefix: "Treasury:",
    name: "U.S. Department of the Treasury",
    href: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve",
  },
  { from: "frankfurter", prefix: "Exchange rates:", name: "Frankfurter", href: "https://frankfurter.dev/" },
  {
    from: "eia",
    // EIA's requested credit wording is "Source: U.S. Energy Information Administration".
    prefix: "Oil: Source:",
    name: "U.S. Energy Information Administration",
    href: "https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.htm",
  },
];

function figure(
  label: string,
  dated: DatedValue | null | undefined,
  format: (n: number) => string,
  from: Source,
  unit?: string
): Figure[] {
  const asOf = dated ? formatDay(dated.date) : null;
  // A value without its day is not shown: EIA's prices can be a week old.
  return dated && asOf ? [{ label, value: format(dated.value), unit, asOf, from }] : [];
}

function figuresFor({ tenYear, fx, oil }: RatesStripData): Figure[] {
  return [
    ...figure("US 10-year Treasury yield", tenYear, formatYield, "treasury"),
    ...figure("EUR/USD", fx?.eurUsd, formatFxRate, "frankfurter"),
    ...figure("USD/MAD", fx?.usdMad, formatFxRate, "frankfurter"),
    ...figure("Brent crude", oil?.brent, formatOilPrice, "eia", "a barrel"),
    ...figure("WTI crude", oil?.wti, formatOilPrice, "eia", "a barrel"),
  ];
}

/**
 * The Markets & Investing strip. Opens with a rule line and a kicker, as
 * every section does, and colours no value by direction: the strip shows
 * levels, not moves. Credits only the sources that supplied a value shown.
 */
export function RatesStrip({ data }: { data: RatesStripData }) {
  const shown = figuresFor(data);
  if (shown.length === 0) return null;
  const credits = CREDITS.filter((credit) => shown.some((f) => f.from === credit.from));
  const muted = { color: "var(--color-muted-foreground)" };

  return (
    <PanelBand label={RATES_STRIP_TITLE}>
      <div className="border-t pt-1.5" style={{ borderColor: "var(--color-rule)" }}>
        <h2 className="text-xs font-semibold tracking-[0.12em] uppercase">{RATES_STRIP_TITLE}</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          {shown.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="text-xs" style={muted}>
                {f.label}
              </dt>
              <dd className="text-base font-semibold tabular-nums">
                {f.value}
                {f.unit && (
                  <span className="text-xs font-normal" style={muted}>
                    {" "}
                    {f.unit}
                  </span>
                )}
              </dd>
              <dd className="text-xs" style={muted}>
                as of {f.asOf}
              </dd>
            </div>
          ))}
        </dl>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={muted}>
          {credits.map((credit) => (
            <li key={credit.from}>
              {credit.prefix}{" "}
              <a href={credit.href} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer">
                {credit.name}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </PanelBand>
  );
}
