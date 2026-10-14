import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicError } from "@anthropic-ai/sdk/error";
import type { TrackedModel, UsageStage } from "@/lib/usage";
import { boundOf, recordCall } from "@/lib/usageCollector";

/** Every step of the app that makes a paid Claude call. */
export type ModelStep =
  | "triage"
  | "dedup"
  | "merge"
  | "rank"
  | "timeline"
  | "writeCardSingle"
  | "writeCardMulti"
  | "expand";

/**
 * The model each paid step runs on. The one place to change it.
 *
 * Every step runs on Claude Haiku 5.5. If one step's quality drops, its
 * revert target is Haiku 4.5 (`claude-haiku-4-5`) for triage, dedup, merge,
 * rank, timeline and single-source cards, and Sonnet 5 (`claude-sonnet-5`)
 * for multi-source cards and the full report. Putting one step back is a
 * change to its entry and nothing else: the request settings follow the
 * model (`requestFor`), and `usage.ts` still prices both models.
 */
export const MODELS: Readonly<Record<ModelStep, TrackedModel>> = Object.freeze({
  triage: "claude-haiku-5-5",
  dedup: "claude-haiku-5-5",
  merge: "claude-haiku-5-5",
  rank: "claude-haiku-5-5",
  timeline: "claude-haiku-5-5",
  writeCardSingle: "claude-haiku-5-5",
  writeCardMulti: "claude-haiku-5-5",
  expand: "claude-haiku-5-5",
});

/**
 * Added to a step's `max_tokens` on Haiku 5.5. Its tokenizer counts the same
 * text as about 30% more tokens than Haiku 4.5's, so a cap sized on the older
 * model can cut off an answer of the same length.
 */
export const HAIKU_55_EXTRA_MAX_TOKENS = 1024;

/** A request as a call site writes it: everything but the model. */
export type BaseRequest = Omit<Anthropic.MessageCreateParamsNonStreaming, "model">;
/**
 * The full request for `model`: the step's own fields plus the ones that
 * belong to the model rather than the step, so reverting a step's model also
 * reverts these.
 *
 * - Haiku 5.5: thinking off at low effort, and `max_tokens` raised. It thinks
 *   by default, and thinking counts against `max_tokens`. Effort goes inside
 *   `output_config`, beside the structured-output `format` the call sends.
 *   `disabled` is accepted only at effort `high` or below.
 * - Sonnet 5: thinking off. It thinks by default, and on these bounded writing
 *   tasks thinking ate into `max_tokens` and truncated the output.
 * - Haiku 4.5: the step's request as written. It doesn't think unless asked.
 *
 * Never add `temperature`, `top_p`, `top_k` or an assistant prefill here: each
 * returns a 400 on Haiku 5.5.
 */
export function requestFor<P extends BaseRequest>(model: TrackedModel, base: P) {
  switch (model) {
    case "claude-haiku-5-5":
      return {
        ...base,
        model,
        max_tokens: base.max_tokens + HAIKU_55_EXTRA_MAX_TOKENS,
        thinking: { type: "disabled" as const },
        output_config: { ...base.output_config, effort: "low" as const },
      };
    case "claude-sonnet-5":
      return { ...base, model, thinking: { type: "disabled" as const } };
    case "claude-haiku-4-5":
      return { ...base, model };
  }
}

/**
 * Thrown when the model declined the request (`stop_reason: "refusal"`). Haiku
 * 5.5's safety classifiers can decline with HTTP 200 and there is no
 * server-side fallback for it, so a refusal reaches each step's own failure
 * path through this error. Its message names the step and the category, which
 * is what each step's failure log prints.
 */
export class RefusalError extends Error {
  readonly stage: UsageStage;
  readonly category: string | null;

  constructor(stage: UsageStage, category: string | null) {
    super(`${stage} refused by the model (category: ${category ?? "none given"})`);
    this.name = "RefusalError";
    this.stage = stage;
    this.category = category;
  }
}

/**
 * One structured-output Claude call: recorded for the run's cost, refusals
 * turned into a `RefusalError`, and the response returned otherwise.
 *
 * The SDK's `messages.parse` parses the text before returning, and throws if
 * it isn't valid output. A refusal that stops mid-answer leaves partial JSON,
 * so a plain `parse` would throw before `stop_reason` could be read, and the
 * refusal would lose both its category and its usage. So the format's parser
 * is wrapped to catch instead: once the response is in hand, a refusal throws
 * `RefusalError` after its usage is recorded, and any other parse failure
 * throws the same error `parse` would have, inside the recorded call, exactly
 * as before.
 *
 * `params.model` is the model recorded, so the two can't disagree.
 */
export async function callModel<P extends Anthropic.MessageCreateParamsNonStreaming>(
  client: Anthropic,
  stage: UsageStage,
  params: P & { model: TrackedModel },
  options?: Anthropic.RequestOptions
) {
  let parseError: { error: unknown } | null = null;
  const format = params.output_config?.format;
  const tolerant =
    format !== null && format !== undefined && "parse" in format && typeof format.parse === "function"
      ? {
          ...params,
          output_config: {
            ...params.output_config,
            format: {
              ...format,
              parse: (text: string) => {
                try {
                  return (format.parse as (text: string) => unknown)(text);
                } catch (error) {
                  parseError ??= { error };
                  return null;
                }
              },
            },
          },
        }
      : params;

  const response = await recordCall(
    stage,
    params.model,
    async () => {
      const message = await client.messages.parse(tolerant as P, options);
      if (message.stop_reason !== "refusal" && parseError !== null) {
        // The wording `messages.parse` itself throws with.
        throw new AnthropicError(`Failed to parse structured output: ${parseError.error}`);
      }
      return message;
    },
    boundOf(params, client.maxRetries + 1)
  );

  if (response.stop_reason === "refusal") {
    throw new RefusalError(stage, response.stop_details?.category ?? null);
  }
  return response;
}
