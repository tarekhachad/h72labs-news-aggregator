// A digest's date is the reader's calendar day, in the timezone stored for
// them in user_settings. This module is the one definition of that day, and
// it imports nothing server-side so the client components that match live
// generation state to a page can use the same function the server does.

import { bestEffortLog } from "@/lib/bestEffortLog";

/** Used for a user with no stored timezone yet, and for any name Intl rejects. */
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * The instant Morocco, and Western Sahara with it, moved to UTC+0 for good.
 * Runtimes whose tz database predates release 2026c still apply UTC+1 (with
 * a UTC+0 Ramadan exception), which dates a Moroccan reader an hour ahead
 * from 23:00 local.
 */
export const MOROCCO_GMT_SINCE = Date.UTC(2026, 8, 20, 1);
const MOROCCO_ZONES = new Set(["Africa/Casablanca", "Africa/El_Aaiun"]);

/**
 * The zone to format with. On a runtime that still has Morocco's old rules,
 * a Moroccan zone after the move is read as UTC, which is what the new rules
 * say it is. Everything else passes through unchanged.
 */
export function moroccoCorrectedZone(zone: string, now: Date, runtimeRulesStale: boolean): string {
  if (!runtimeRulesStale || !MOROCCO_ZONES.has(zone)) return zone;
  return now.getTime() >= MOROCCO_GMT_SINCE ? "UTC" : zone;
}

let moroccoRulesStale: boolean | undefined;

/**
 * Asks the runtime's own rules rather than reading a version string, because
 * the browser runs this too and has no process.versions. Once a runtime ships
 * the new rules the probe reads false and the correction switches itself off.
 */
function runtimeHasStaleMoroccoRules(): boolean {
  if (moroccoRulesStale === undefined) {
    // 23:30 UTC a few days after the move: the new rules keep it on that day
    // in Casablanca, the old ones carry it into the next. An instant already
    // past, because a tz release never rewrites a transition that happened.
    moroccoRulesStale = formatDate(new Date(Date.UTC(2026, 8, 25, 23, 30)), "Africa/Casablanca") === "2026-09-26";
    const tz = typeof process !== "undefined" ? process.versions?.tz : undefined;
    if (tz) {
      bestEffortLog("log", `[tz] runtime tz database ${tz}; Morocco GMT correction ${moroccoRulesStale ? "on" : "off"}`);
    }
  }
  return moroccoRulesStale;
}

/**
 * Whether Intl accepts this IANA name. Postgres validates the stored value
 * against its own tzdata, which can differ from the runtime's ICU build, so
 * a name the database accepted is not guaranteed to work here.
 *
 * The type check is not redundant with the signature: Intl reads a missing
 * timeZone as "the host's zone" rather than rejecting it, so an undefined
 * slipping past the types would pass as valid and file digests under the
 * server's local date instead of falling back to UTC.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar date at `now` in `timeZone`, as YYYY-MM-DD.
 *
 * Built from formatToParts rather than from the en-CA formatted string:
 * en-CA happens to render YYYY-MM-DD today, but that is locale data, not a
 * contract, and a changed separator would silently break every equality
 * check against digests.date.
 *
 * An invalid name falls back to UTC instead of throwing, because this runs
 * during page render and a bad stored value must not take the page down.
 */
export function dateInTimeZone(now: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const stale = MOROCCO_ZONES.has(zone) && runtimeHasStaleMoroccoRules();
  return formatDate(now, moroccoCorrectedZone(zone, now, stale));
}

function formatDate(now: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The browser's own timezone, or null where Intl cannot say. Client-only. */
export function deviceTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}
