import { cache } from "react";

/**
 * A fetch that retries once when the database refuses a token as "issued at
 * future".
 *
 * Supabase Auth and the database check time on different clocks. A token
 * issued a moment ago can look a fraction of a second early to the database,
 * which refuses it, and the page then fails. That shows up right after a
 * password reset, where the very next request carries a brand-new token.
 * Waiting a second is enough for the clocks to agree.
 *
 * The refusal happens before any SQL runs, so resending the same request
 * can't apply a write twice.
 */

const SKEW_MESSAGE = "JWT issued at future";

export const CLOCK_SKEW_RETRY_MS = 1000;

type Fetch = typeof fetch;
type SkewWaits = Map<string, Promise<void>>;

// One server-component render's skew waits, by request. Next dedupes identical
// GET and HEAD requests for the length of a render, so a later identical
// request gets the same cached refusal, and the wait already paid for it
// covers it too. React's cache is the scope Next's dedupe uses; outside a
// render it keeps nothing, and every request waits for itself.
const renderSkewWaits = cache((): SkewWaits => new Map());

export function clockSkewRetryFetch(
  base: Fetch = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  skewWaits: () => SkewWaits = renderSkewWaits
): Fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (!(await refusedForSkew(response))) return response;

    const key = dedupedRequestKey(input, init);
    if (key === null) {
      await wait(CLOCK_SKEW_RETRY_MS);
    } else {
      const waits = skewWaits();
      let shared = waits.get(key);
      if (!shared) {
        shared = wait(CLOCK_SKEW_RETRY_MS);
        waits.set(key, shared);
      }
      await shared;
    }
    // During a server-component render, Next dedupes identical GETs and would
    // hand back the cached 401 instead of asking again. A request carrying a
    // signal is Next's opt-out from that cache, so the resend always carries one.
    return base(input, { ...init, signal: init?.signal ?? new AbortController().signal });
  };
}

async function refusedForSkew(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  // PostgREST names a token refusal's reason in WWW-Authenticate as well as in
  // the body. A HEAD refusal has no body, so the header is all it carries; a
  // body-less 401 without it gives no reason and is not retried.
  if (response.headers.get("www-authenticate")?.includes(SKEW_MESSAGE)) return true;
  const text = await response.clone().text().catch(() => "");
  return text.includes(SKEW_MESSAGE);
}

// The requests Next could have answered from one cached response: GET or HEAD,
// same URL, same headers. Anything else gets a wait of its own.
function dedupedRequestKey(input: RequestInfo | URL, init: RequestInit | undefined): string | null {
  // Checked before building a Request, which would take over a streamed body
  // the resend still needs. GET and HEAD carry none.
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  let request: Request;
  try {
    request = new Request(input, init);
  } catch {
    return null;
  }
  if (request.keepalive) return null;
  return JSON.stringify([request.method, request.url, [...request.headers]]);
}
