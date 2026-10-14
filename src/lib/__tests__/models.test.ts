import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicError } from "@anthropic-ai/sdk/error";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  HAIKU_55_EXTRA_MAX_TOKENS,
  MODELS,
  RefusalError,
  callModel,
  requestFor,
  type ModelStep,
} from "@/lib/models";
import { TRACKED_MODELS, PRICING } from "@/lib/usage";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";

const STEPS: ModelStep[] = [
  "triage",
  "dedup",
  "merge",
  "rank",
  "timeline",
  "writeCardSingle",
  "writeCardMulti",
  "expand",
];

const Answer = z.object({ answer: z.number() });

/** A step's request as a call site writes it, before the model is chosen. */
function base() {
  return {
    max_tokens: 2048,
    system: "You answer with a number.",
    messages: [{ role: "user" as const, content: "What is 2 + 2?" }],
    output_config: { format: zodOutputFormat(Answer) },
  };
}

describe("MODELS", () => {
  it("runs every step on Haiku 5.5", () => {
    expect(Object.keys(MODELS).sort()).toEqual([...STEPS].sort());
    for (const step of STEPS) expect(MODELS[step]).toBe("claude-haiku-5-5");
  });

  it("names only models the pricing table can price, so a revert stays priced", () => {
    for (const step of STEPS) {
      expect(TRACKED_MODELS).toContain(MODELS[step]);
      expect(PRICING[MODELS[step]]).toBeDefined();
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(MODELS)).toBe(true);
  });
});

describe("requestFor: the request settings belong to the model", () => {
  it("sends Haiku 4.5 exactly the step's request, as before the switch", () => {
    const b = base();
    expect(requestFor("claude-haiku-4-5", b)).toStrictEqual({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      system: b.system,
      messages: b.messages,
      output_config: { format: b.output_config.format },
    });
  });

  it("sends Sonnet 5 the step's request with thinking off, as before the switch", () => {
    const b = base();
    expect(requestFor("claude-sonnet-5", b)).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      thinking: { type: "disabled" },
      system: b.system,
      messages: b.messages,
      output_config: { format: b.output_config.format },
    });
  });

  it("sends Haiku 5.5 thinking off at low effort, with max_tokens raised by 1024", () => {
    const b = base();
    expect(HAIKU_55_EXTRA_MAX_TOKENS).toBe(1024);
    expect(requestFor("claude-haiku-5-5", b)).toStrictEqual({
      model: "claude-haiku-5-5",
      max_tokens: 2048 + 1024,
      thinking: { type: "disabled" },
      system: b.system,
      messages: b.messages,
      // Effort sits beside the structured-output format, not instead of it.
      output_config: { format: b.output_config.format, effort: "low" },
    });
  });

  it("adds effort on Haiku 5.5 when the step sends no output_config", () => {
    const r = requestFor("claude-haiku-5-5", { max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect((r as { output_config?: unknown }).output_config).toEqual({ effort: "low" });
  });

  it("does not modify the step's own object", () => {
    const b = base();
    const before = JSON.stringify(b);
    requestFor("claude-haiku-5-5", b);
    expect(JSON.stringify(b)).toBe(before);
  });

  it.each(STEPS)("%s: sends nothing Haiku 5.5 rejects (no sampling parameters, no prefill)", (step) => {
    const r = requestFor(MODELS[step], base()) as Record<string, unknown>;
    for (const key of ["temperature", "top_p", "top_k", "fallbacks"]) expect(key in r).toBe(false);
    const messages = r.messages as { role: string }[];
    expect(messages[messages.length - 1].role).toBe("user");
  });
});

/** A client whose `messages.parse` resolves to whatever `respond` builds. */
function fakeClient(respond: (params: Record<string, unknown>) => Record<string, unknown>) {
  const parse = vi.fn<(params: Record<string, unknown>, options?: unknown) => Promise<Record<string, unknown>>>(
    async (params) => respond(params)
  );
  return { client: { maxRetries: 2, messages: { parse } } as unknown as Anthropic, parse };
}

const USAGE = { input_tokens: 300, output_tokens: 12 };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("callModel", () => {
  it("returns the response and records it on the request's own model", async () => {
    const { client } = fakeClient(() => ({ stop_reason: "end_turn", parsed_output: { answer: 4 }, usage: USAGE }));
    const usage = createUsageCollector();
    const params = requestFor(MODELS.rank, base());
    const response = await withUsageCollector(usage, () => callModel(client, "rank", params));
    expect(response.parsed_output).toEqual({ answer: 4 });
    expect(usage.calls()).toEqual([
      { stage: "rank", model: params.model, tokens: { inputTokens: 300, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]);
  });

  it("passes request options through", async () => {
    const { client, parse } = fakeClient(() => ({ stop_reason: "end_turn", parsed_output: { answer: 4 } }));
    await callModel(client, "timeline", requestFor(MODELS.timeline, base()), { timeout: 1234 });
    expect(parse.mock.calls[0][1]).toEqual({ timeout: 1234 });
  });

  it("throws RefusalError with the category on a refusal, after recording its usage", async () => {
    const { client } = fakeClient(() => ({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
      content: [],
      parsed_output: null,
      usage: USAGE,
    }));
    const usage = createUsageCollector();
    const error = await withUsageCollector(usage, () =>
      callModel(client, "dedup", requestFor(MODELS.dedup, base()))
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).category).toBe("cyber");
    expect((error as RefusalError).message).toBe("dedup refused by the model (category: cyber)");
    expect(usage.calls()).toHaveLength(1);
    expect(usage.calls()[0].tokens).toEqual({ inputTokens: 300, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("names a refusal with no category as such", async () => {
    const { client } = fakeClient(() => ({ stop_reason: "refusal", stop_details: null, content: [], parsed_output: null }));
    const error = await callModel(client, "rank", requestFor(MODELS.rank, base())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).category).toBeNull();
    expect((error as Error).message).toContain("category: none given");
  });

  it("reads a refusal that stopped mid-answer as a refusal, not a parse failure", async () => {
    // What the SDK's parse does: run the format's parser over each text block.
    const { client } = fakeClient((params) => {
      const format = (params.output_config as { format: { parse: (t: string) => unknown } }).format;
      const parsed = format.parse('{"answ');
      return { stop_reason: "refusal", stop_details: { category: "bio" }, parsed_output: parsed, usage: USAGE };
    });
    const usage = createUsageCollector();
    const error = await withUsageCollector(usage, () =>
      callModel(client, "triage", requestFor(MODELS.triage, base()))
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).category).toBe("bio");
    expect(usage.calls()[0].tokens).not.toBeNull();
  });

  it("throws the SDK's own parse error for unparseable output that wasn't refused, recorded as before", async () => {
    const { client } = fakeClient((params) => {
      const format = (params.output_config as { format: { parse: (t: string) => unknown } }).format;
      return { stop_reason: "end_turn", parsed_output: format.parse("not json"), usage: USAGE };
    });
    const usage = createUsageCollector();
    const params = requestFor(MODELS.merge, base());
    const error = await withUsageCollector(usage, () => callModel(client, "merge", params)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnthropicError);
    expect((error as Error).message).toMatch(/^Failed to parse structured output: /);
    // A throw inside the recorded call: billed, amount unknown, with its ceiling.
    expect(usage.calls()).toEqual([
      {
        stage: "merge",
        model: params.model,
        tokens: null,
        bound: { requestBytes: expect.any(Number), maxOutputTokens: params.max_tokens, attempts: 3 },
      },
    ]);
  });

  it("rethrows a failed call unchanged", async () => {
    const boom = new Error("rate limited");
    const { client } = fakeClient(() => {
      throw boom;
    });
    await expect(callModel(client, "rank", requestFor(MODELS.rank, base()))).rejects.toBe(boom);
  });
});

describe("callModel through the real SDK", () => {
  /** A real client whose only network is `answer`. */
  function realClient(answer: object) {
    return new Anthropic({
      apiKey: "qa-not-a-real-key",
      baseURL: "http://qa.invalid",
      maxRetries: 0,
      fetch: (async () =>
        new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_sequence: null, ...answer }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
  }

  it("parses a normal answer", async () => {
    const client = realClient({ content: [{ type: "text", text: '{"answer":4}' }], stop_reason: "end_turn", usage: USAGE });
    const response = await callModel(client, "rank", requestFor(MODELS.rank, base()));
    expect(response.parsed_output).toEqual({ answer: 4 });
  });

  it("turns a mid-answer refusal into RefusalError instead of a parse error", async () => {
    const client = realClient({
      content: [{ type: "text", text: '{"ans' }],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "general_harms", explanation: null },
      usage: USAGE,
    });
    const usage = createUsageCollector();
    const error = await withUsageCollector(usage, () =>
      callModel(client, "expand", requestFor(MODELS.expand, base()))
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusalError);
    expect((error as RefusalError).category).toBe("general_harms");
    expect(usage.calls()[0].tokens).toMatchObject({ inputTokens: 300, outputTokens: 12 });
  });

  it("still fails an unparseable answer that wasn't refused", async () => {
    const client = realClient({ content: [{ type: "text", text: '{"answer":"four"}' }], stop_reason: "end_turn", usage: USAGE });
    await expect(callModel(client, "rank", requestFor(MODELS.rank, base()))).rejects.toThrow(
      /^Failed to parse structured output: /
    );
  });

  it("reads the answer by block type, past a leading thinking block", async () => {
    const client = realClient({
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: '{"answer":4}' },
      ],
      stop_reason: "end_turn",
      usage: USAGE,
    });
    const response = await callModel(client, "rank", requestFor(MODELS.rank, base()));
    expect(response.parsed_output).toEqual({ answer: 4 });
  });
});
