import Anthropic from "@anthropic-ai/sdk";
import { GenerationRejectedError, type RejectionReason } from "@/lib/claudeText";
import type { TrackedModel } from "@/lib/usage";

/**
 * Why one notable cluster produced no card, in the form stored on its run's
 * `usage_runs.card_failures`.
 *
 * The split that matters is `apiError` against everything else. An API error
 * returns nothing billable and may well succeed next time; every other reason
 * is a response Claude was paid for and the app then refused, which a retry
 * of the identical request does not reliably fix.
 */
export interface CardFailure {
  reason: RejectionReason | "apiError" | "other";
  model: TrackedModel;
  articleCount: number;
  /** Only for `GenerationRejectedError`. */
  stopReason?: string | null;
  /** The end of the rejected text. Only for `GenerationRejectedError`. */
  tail?: string;
  /** HTTP status. Only for `apiError`, and absent there on a connection failure. */
  status?: number;
  /** The error's name. Only for `other`, where the reason is otherwise unknown. */
  errorName?: string;
}

export function classifyCardFailure(
  error: unknown,
  model: TrackedModel,
  articleCount: number
): CardFailure {
  if (error instanceof GenerationRejectedError) {
    return {
      reason: error.reason,
      model,
      articleCount,
      stopReason: error.stopReason,
      tail: error.tail,
    };
  }
  if (error instanceof Anthropic.APIError) {
    return {
      reason: "apiError",
      model,
      articleCount,
      ...(typeof error.status === "number" ? { status: error.status } : {}),
    };
  }
  return {
    reason: "other",
    model,
    articleCount,
    errorName: error instanceof Error ? error.name : typeof error,
  };
}
