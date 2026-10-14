import "server-only";
import { fetchCappedText, PanelFetchError } from "./fetchJson";
import { isIsoDay } from "./isoDay";

/** A daily figure and the day (YYYY-MM-DD) it describes. */
export type DatedValue = { value: number; date: string };

const FEED = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";
// A full month is about 23 entries of 1.6 KB each.
const MAX_BYTES = 256 * 1024;
// No month has more trading days than this; a feed with more entries is not the one asked for.
const MAX_ENTRIES = 31;
// An uncached month took 17 s to answer when measured; the strip loads in its
// own Suspense slot, so a slow answer delays only the strip.
export const TREASURY_TIMEOUT_MS = 25_000;

// Every attribute run is bounded, so a tag that never closes costs a fixed
// amount per occurrence rather than a scan to the end of the body.
const FEED_ROOT = /^\s*(?:<\?xml[^>]{0,256}\?>\s*)?<feed\b[^>]{0,1024}>/;
const FEED_TITLE = /<title\b[^>]{0,64}>DailyTreasuryYieldCurveRateData<\/title>/;
const PROPERTIES_OPEN = "<m:properties>";
const PROPERTIES_CLOSE = "</m:properties>";
// A missing value is written as an empty element with m:null="true", which this does not match.
const NEW_DATE = /<d:NEW_DATE\b[^>]{0,64}>(\d{4}-\d{2}-\d{2})T00:00:00<\/d:NEW_DATE>/;
const TEN_YEAR = /<d:BC_10YEAR\b[^>]{0,64}>(-?\d{1,3}(?:\.\d{1,4})?)<\/d:BC_10YEAR>/;

/** "202610": the feed's month filter. */
export function feedMonth(day: Date): string {
  return `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month before `day`'s, as a Date inside it. */
function monthBefore(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, 1));
}

/**
 * The latest 10-year yield in one month's feed, or null when the month has
 * no rows yet. A small, bounded reader of the feed's fixed Atom layout, not
 * a general XML parser: the body is size-capped before it gets here, entries
 * are found by literal tags, and each pattern starts at a literal tag, so the
 * work stays linear in the body's length.
 * Throws PanelFetchError on anything that is not that feed.
 */
export function parseTreasuryFeed(xml: string): DatedValue | null {
  if (!FEED_ROOT.test(xml) || !FEED_TITLE.test(xml)) {
    throw new PanelFetchError("Treasury body is not the daily yield curve feed");
  }
  // Split on the literal tags rather than one lazy pattern across the body,
  // which would rescan to the end once per unclosed tag.
  const opened = xml.split(PROPERTIES_OPEN).slice(1);
  if (opened.length > MAX_ENTRIES) throw new PanelFetchError("Treasury feed has more entries than a month");
  let latest: DatedValue | null = null;
  for (const chunk of opened) {
    const end = chunk.indexOf(PROPERTIES_CLOSE);
    if (end === -1) throw new PanelFetchError("Treasury feed has an unclosed entry");
    const properties = chunk.slice(0, end);
    const date = NEW_DATE.exec(properties)?.[1];
    const raw = TEN_YEAR.exec(properties)?.[1];
    if (!date || !isIsoDay(date) || raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (!latest || date > latest.date) latest = { value, date };
  }
  return latest;
}

async function readMonth(month: string): Promise<DatedValue | null> {
  const url = `${FEED}?data=daily_treasury_yield_curve&field_tdr_date_value_month=${month}`;
  const xml = await fetchCappedText(url, {
    maxBytes: MAX_BYTES,
    accept: "application/xml, text/xml",
    timeoutMs: TREASURY_TIMEOUT_MS,
  });
  return parseTreasuryFeed(xml);
}

/**
 * The latest US 10-year Treasury par yield (percent) from the Treasury's
 * daily yield curve feed (public domain). Early in a month the current
 * month has no rows yet, so the previous month answers. Throws
 * PanelFetchError on any failure, including two empty months in a row, so
 * nothing but a real yield is ever cached.
 */
export async function fetchTreasuryTenYear(now: Date = new Date()): Promise<DatedValue> {
  const latest = (await readMonth(feedMonth(now))) ?? (await readMonth(feedMonth(monthBefore(now))));
  if (!latest) throw new PanelFetchError("Treasury feed has no 10-year yield this month or last");
  return latest;
}
