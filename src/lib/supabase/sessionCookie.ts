import { bestEffortLog } from "@/lib/bestEffortLog";

/**
 * Tells this project's session cookies apart from every other cookie.
 *
 * @supabase/ssr keeps the session in `sb-<project ref>-auth-token`, split
 * into `.0`, `.1`, … when it is too large for one cookie. The ref is the first
 * label of SUPABASE_URL's hostname, which is how supabase-js names it too.
 * Matching the exact name means clearing a session never touches another
 * Supabase project's cookie on the same host.
 *
 * Without a usable SUPABASE_URL nothing matches: a missed clear only leaves a
 * cookie behind, while falling back to a wide pattern could clear someone
 * else's.
 */
export function sessionCookieMatcher(supabaseUrl = process.env.SUPABASE_URL): (name: string) => boolean {
  const base = sessionCookieName(supabaseUrl);
  if (!base) {
    bestEffortLog("error", "[sessionCookie] SUPABASE_URL is missing or unparseable; no session cookie will be cleared");
    return () => false;
  }
  return (name) => {
    if (name === base) return true;
    if (!name.startsWith(`${base}.`)) return false;
    return /^\d+$/.test(name.slice(base.length + 1));
  };
}

function sessionCookieName(supabaseUrl: string | undefined): string | null {
  const trimmed = supabaseUrl?.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null;
  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname;
  } catch {
    return null;
  }
  const ref = hostname.split(".")[0];
  return ref ? `sb-${ref}-auth-token` : null;
}

// The scope @supabase/ssr writes the session cookies with, so an expiry
// replaces them. Expires is what survives a route handler: Next re-parses the
// returned response's Set-Cookie lines to merge in the cookie store's writes,
// and its parser drops a Max-Age of 0 as if it were unset.
export const EXPIRED_SESSION_COOKIE = { path: "/", sameSite: "lax", maxAge: 0, expires: 0 } as const;
