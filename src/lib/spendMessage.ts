/**
 * The words a spend-cap refusal is shown in. Shared by the routes, which pick
 * the sentence, and the browser, which appends the time in the reader's own
 * timezone (the server does not know it).
 *
 * No server imports: client components import this file.
 */

export type SpendKind = "digest" | "expand";

export type SpendRefusalReason =
  | "disabled"
  | "user_count"
  | "too_large"
  | "user_budget"
  | "global_budget";

/** The JSON body of a 429 or 503 from a spending route. */
export type SpendRefusalBody = {
  reason: SpendRefusalReason | "error";
  message: string;
  availableAt: string | null;
};

export function spendRefusalMessage(kind: SpendKind, reason: SpendRefusalReason | "error"): string {
  switch (reason) {
    case "disabled":
      return "Generating is paused right now. Try again later.";
    case "user_count":
      return kind === "digest"
        ? "You've reached your limit of digest runs for now."
        : "You've reached your limit of full reports for now.";
    case "too_large":
      return "This request is bigger than the current usage limit allows.";
    case "user_budget":
      return "You've reached your usage limit for now.";
    case "global_budget":
      return "News generation has reached its limit for everyone for now.";
    case "error":
      return "Couldn't check your usage limit. Try again in a moment.";
  }
}

/** "Available again at 7:42 PM." or "... tomorrow at ...", in local time. */
export function describeAvailableAt(iso: string, now: Date = new Date()): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === now.toDateString()) return `Available again at ${time}.`;
  if (at.toDateString() === tomorrow.toDateString()) return `Available again tomorrow at ${time}.`;
  return `Available again ${at.toLocaleDateString(undefined, { weekday: "long" })} at ${time}.`;
}

/**
 * The text to show for a failed response: a spend refusal's sentence plus its
 * local time when the body is one, otherwise the plain-text body, otherwise
 * `fallback`.
 */
export async function errorMessageFromResponse(res: Response, fallback: string): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && typeof (body as SpendRefusalBody).message === "string") {
        const { message, availableAt } = body as SpendRefusalBody;
        const when = typeof availableAt === "string" ? describeAvailableAt(availableAt) : null;
        return when ? `${message} ${when}` : message;
      }
      return fallback;
    }
    const text = await res.text();
    return text || fallback;
  } catch {
    return fallback;
  }
}

const EXPAND_FAILED = "Couldn't load the full report — try again.";

/**
 * The message for a failed expand. Only a spend refusal (429/503) carries a
 * sentence worth showing; any other failure keeps the generic retry prompt
 * rather than surfacing server text.
 */
export async function expandErrorMessage(res: Response): Promise<string> {
  if (res.status === 429 || res.status === 503) {
    return errorMessageFromResponse(res, EXPAND_FAILED);
  }
  return EXPAND_FAILED;
}
