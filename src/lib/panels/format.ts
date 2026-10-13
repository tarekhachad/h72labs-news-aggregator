import type { YearValue } from "./worldBank";

// The World Bank's annual figures are estimates; one decimal at the scale
// a reader thinks in is as precise as the box claims to be.
const ONE_DECIMAL = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function withYear(text: string, figure: YearValue): string {
  return `${text} (${figure.year})`;
}

/**
 * The largest unit the value still shows as at least 1.0 of, so a value just
 * under a boundary reads "1.0 billion" rather than "1,000.0 million".
 */
function inUnit(n: number, units: readonly (readonly [number, string])[]): string | null {
  for (const [size, name] of units) {
    if (n >= size * 0.99995) return `${ONE_DECIMAL.format(n / size)} ${name}`;
  }
  return null;
}

/** "55.3 million (2024)", "1.4 billion (2024)", "393,000 (2024)". */
export function formatPopulation(figure: YearValue): string {
  const text =
    inUnit(figure.value, [
      [1e9, "billion"],
      [1e6, "million"],
    ]) ?? WHOLE.format(Math.round(figure.value / 1000) * 1000);
  return withYear(text, figure);
}

/** "$108.0 bn (2024)", "$27.4 tn (2024)", "$850.0 m (2024)". */
export function formatUsd(figure: YearValue): string {
  const text =
    inUnit(figure.value, [
      [1e12, "tn"],
      [1e9, "bn"],
    ]) ?? `${ONE_DECIMAL.format(figure.value / 1e6)} m`;
  return withYear(`$${text}`, figure);
}

/** "4.5% (2024)", "−0.3% (2024)". */
export function formatPercent(figure: YearValue): string {
  const rounded = ONE_DECIMAL.format(Math.abs(figure.value));
  // A value that rounds to 0.0 gets no sign.
  const sign = figure.value < 0 && rounded !== "0.0" ? "−" : "";
  return withYear(`${sign}${rounded}%`, figure);
}
