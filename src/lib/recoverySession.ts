/**
 * Tells a session established by a password-recovery link apart from an
 * ordinary one.
 *
 * /reset-password changes a password and then signs every other session out.
 * Gating that on "is anyone logged in" would hand the eviction to whoever
 * holds a session cookie, so a stolen session could lock the real owner out
 * without ever reaching their inbox — the reverse of what the flow is for.
 * Proof of inbox control is what the `recovery` entry in the token's `amr`
 * claim records, and the claim is signed by Supabase, so a session that
 * logged in with a password cannot present one.
 */

/** Matches the link's own lifetime: a recovery session goes stale as fast. */
const RECOVERY_WINDOW_SECONDS = 60 * 60;

/** Tolerance for clock drift between this server and Supabase. */
const FUTURE_SKEW_SECONDS = 60;

type AmrEntry = { method?: unknown; timestamp?: unknown };

export function isRecoverySession(
  claims: unknown,
  // Read here rather than at the call sites: one of them is a server
  // component, where the lint rule forbids calling Date.now() during render.
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  const amr = (claims as { amr?: unknown } | null | undefined)?.amr;
  if (!Array.isArray(amr)) return false;

  return amr.some((entry: AmrEntry) => {
    if (entry?.method !== "recovery") return false;
    // A missing or non-numeric timestamp fails closed: without one there is
    // no way to tell a recovery from an hour ago from one from last month,
    // and a long-lived recovery session is exactly what this window exists
    // to stop being reusable.
    if (typeof entry.timestamp !== "number") return false;
    const age = nowSeconds - entry.timestamp;
    return age <= RECOVERY_WINDOW_SECONDS && age >= -FUTURE_SKEW_SECONDS;
  });
}
