// A digest's date is the reader's calendar day, in the timezone stored for
// them in user_settings. This module is the one definition of that day, and
// it imports nothing server-side so the client components that match live
// generation state to a page can use the same function the server does.

/** Used for a user with no stored timezone yet, and for any name Intl rejects. */
export const DEFAULT_TIME_ZONE = "UTC";

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
