/**
 * Logs a line that only reports on work already done, and never throws.
 *
 * The pipeline's rule: anything that runs after a successful billed Claude
 * call and merely reports on it is best-effort by construction. A log line
 * there that throws (a closed stdout, a patched console) is otherwise
 * indistinguishable from the call itself failing, so the caller's error
 * handling drops a result that was already paid for. Every such log goes
 * through here, so the guarantee is a property of the call site rather than
 * a try/catch each one has to remember.
 *
 * The failure is swallowed silently. The only thing that can throw in here is
 * the console itself, and a console that just failed is not one to report the
 * failure on. Arguments are evaluated by the caller before this runs, so keep
 * them to values that cannot throw while being built.
 */
export function bestEffortLog(level: "log" | "warn" | "error", ...args: unknown[]): void {
  try {
    console[level](...args);
  } catch {
    // A lost log line must never cost a paid result.
  }
}
