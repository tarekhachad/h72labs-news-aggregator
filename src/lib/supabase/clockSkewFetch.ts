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

export function clockSkewRetryFetch(
  base: Fetch = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status !== 401) return response;

    const text = await response.clone().text().catch(() => "");
    if (!text.includes(SKEW_MESSAGE)) return response;

    await wait(CLOCK_SKEW_RETRY_MS);
    // During a server-component render, Next dedupes identical GETs and would
    // hand back the cached 401 instead of asking again. A request carrying a
    // signal is Next's opt-out from that cache, so the resend always carries one.
    return base(input, { ...init, signal: init?.signal ?? new AbortController().signal });
  };
}
