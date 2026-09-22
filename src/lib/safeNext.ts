/**
 * Sanitizes a `next=` redirect target taken from a URL, for the two routes
 * that finish an email link (src/app/auth/callback, src/app/auth/confirm).
 *
 * Only same-origin relative paths are allowed. Concatenating an unvalidated
 * `next` onto an origin is an open-redirect: "@evil.example/" turns
 * "${origin}${next}" into a URL the parser reads as pointing at
 * evil.example, and a leading "//" is read by browsers as protocol-relative,
 * i.e. another origin entirely.
 */
export function safeNextPath(requested: string | null | undefined, fallback = "/"): string {
  if (typeof requested !== "string") return fallback;
  return requested.startsWith("/") && !requested.startsWith("//") ? requested : fallback;
}
