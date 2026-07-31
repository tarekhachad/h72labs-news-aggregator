// Shared truncation-safety logic for any Claude text-generation call in this
// app (currently: writeCard's shortSummary, cards.ts's expandedReport).
// Extracted so both call sites share one proven strategy instead of two
// truncation-detection implementations drifting apart over time.

/** A generation's text plus the stop_reason it came back with. */
export interface GenerationResult {
  text: string;
  stopReason: string | null;
}

export function looksComplete(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim());
}

/**
 * Runs `generate()`, and handles the three outcomes the same way every
 * generation in this app should:
 * - Empty text: never salvageable, throw immediately.
 * - Looks complete: return it, done.
 * - Looks truncated with a confirmed-bad stop_reason (anything but
 *   "end_turn"): that's already a known-bad signal, throw immediately —
 *   retrying wouldn't change that this specific response is bad.
 * - Looks truncated but stop_reason is "end_turn": genuinely ambiguous —
 *   the model believes it finished, but the text doesn't look complete.
 *   "end_turn" alone can't distinguish a one-off bad generation from
 *   content that's actually fine, so retry once before giving up.
 *
 * `label` is used only in error/warning messages, to identify which
 * generation (summary vs. expanded report) failed.
 */
export async function generateWithRetryOnAmbiguousTruncation(
  generate: () => Promise<GenerationResult>,
  label: string
): Promise<string> {
  const initial = await generate();
  const text = initial.text;
  const stopReason = initial.stopReason;

  if (text.trim().length === 0) {
    throw new Error(`${label} produced empty output (stop_reason: ${stopReason})`);
  }

  if (looksComplete(text)) {
    return text;
  }

  if (stopReason !== "end_turn") {
    throw new Error(
      `${label} produced a truncated output (stop_reason: ${stopReason}): "${text}"`
    );
  }

  console.warn(
    `[${label}] output looked incomplete (stop_reason: end_turn) — retrying once: "${text.slice(0, 200)}${text.length > 200 ? "…" : ""}"`
  );
  const retry = await generate();
  if (retry.text.trim().length === 0 || !looksComplete(retry.text)) {
    throw new Error(
      `${label} produced an incomplete output even after retry (stop_reason: ${retry.stopReason}): "${retry.text}"`
    );
  }
  return retry.text;
}
