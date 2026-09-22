/**
 * Tells a session established by a password-recovery link apart from an
 * ordinary one.
 *
 * /reset-password sets a new password without asking for the old one, so it
 * is meant to be reached from an emailed link rather than from an ordinary
 * signed-in session, which has /profile for that.
 * Proof of inbox control is what the token's `amr` claim records, and the
 * claim is signed by Supabase, so a session that logged in with a password
 * cannot present one.
 *
 * Both `otp` and `recovery` count. Auth records a token-hash email link as
 * `otp` whatever the link was for, and `recovery` appears only on some
 * flows, so accepting the narrower value alone rejects every real reset
 * link. `otp` still means the holder opened an email this app sent, which
 * is the property being checked; a password login records `password` and is
 * refused either way.
 */

/** Matches the link's own lifetime: a recovery session goes stale as fast. */
const RECOVERY_WINDOW_SECONDS = 60 * 60;

/** Tolerance for clock drift between this server and Supabase. */
const FUTURE_SKEW_SECONDS = 60;

const INBOX_METHODS: readonly unknown[] = ["recovery", "otp"];

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
    if (!INBOX_METHODS.includes(entry?.method)) return false;
    // A missing or non-numeric timestamp fails closed: without one there is
    // no way to tell a recovery from an hour ago from one from last month,
    // and a long-lived recovery session is exactly what this window exists
    // to stop being reusable.
    if (typeof entry.timestamp !== "number") return false;
    const age = nowSeconds - entry.timestamp;
    return age <= RECOVERY_WINDOW_SECONDS && age >= -FUTURE_SKEW_SECONDS;
  });
}
