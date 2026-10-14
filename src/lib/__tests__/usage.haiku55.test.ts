import { describe, it, expect } from "vitest";
import {
  PRICING,
  REQUEST_OVERHEAD_TOKENS,
  costFor,
  formatCallLine,
  promptTokens,
  rateCardFor,
  summarizeUsage,
  type CallTokens,
  type ModelPricing,
  type RecordedCall,
  type TrackedModel,
} from "@/lib/usage";

const AT = new Date("2026-10-13T12:00:00Z");

const tk = (p: Partial<CallTokens>): CallTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...p,
});

// Re-typed from Anthropic's published Haiku 5.5 prices, not read off PRICING,
// so a wrong table can't agree with itself.
const SHORT = { in: 0.1, out: 0.5 };
const LONG = { in: 0.5, out: 2.5 };
const usd = (rate: { in: number; out: number }, t: CallTokens) =>
  (t.inputTokens * rate.in +
    t.cacheWriteTokens * rate.in * 1.25 +
    t.cacheReadTokens * rate.in * 0.1 +
    t.outputTokens * rate.out) /
  1_000_000;

describe("Haiku 5.5 rate cards", () => {
  it("prices a prompt up to 100,000 tokens at $0.10 / $0.50 per MTok", () => {
    const t = tk({ inputTokens: 100_000, outputTokens: 1_000_000 });
    expect(costFor("claude-haiku-5-5", t, AT).billedUsd).toBeCloseTo(0.01 + 0.5, 12);
  });

  it("prices a prompt over 100,000 tokens at $0.50 / $2.50, output included", () => {
    const t = tk({ inputTokens: 100_001, outputTokens: 1_000_000 });
    expect(rateCardFor("claude-haiku-5-5", t)).toBe("longContext");
    expect(costFor("claude-haiku-5-5", t, AT).billedUsd).toBeCloseTo(usd(LONG, t), 12);
    expect(costFor("claude-haiku-5-5", t, AT).listUsd).toBeCloseTo(usd(LONG, t), 12);
  });

  it("pins both sides of the boundary", () => {
    const at = tk({ inputTokens: 100_000, outputTokens: 10 });
    const over = tk({ inputTokens: 100_001, outputTokens: 10 });
    expect(rateCardFor("claude-haiku-5-5", at)).toBe("standard");
    expect(rateCardFor("claude-haiku-5-5", over)).toBe("longContext");
    expect(costFor("claude-haiku-5-5", at, AT).billedUsd).toBeCloseTo(usd(SHORT, at), 15);
    expect(costFor("claude-haiku-5-5", over, AT).billedUsd).toBeCloseTo(usd(LONG, over), 15);
  });

  it("counts cache reads and writes toward the prompt's length", () => {
    const t = tk({ inputTokens: 40_000, cacheReadTokens: 40_000, cacheWriteTokens: 20_001 });
    expect(promptTokens(t)).toBe(100_001);
    expect(rateCardFor("claude-haiku-5-5", t)).toBe("longContext");
    expect(costFor("claude-haiku-5-5", t, AT).billedUsd).toBeCloseTo(usd(LONG, t), 12);
  });

  it("leaves Haiku 4.5 and Sonnet 5 on their single card at any length", () => {
    const t = tk({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(rateCardFor("claude-haiku-4-5", t)).toBe("standard");
    expect(rateCardFor("claude-sonnet-5", t)).toBe("standard");
    expect(costFor("claude-haiku-4-5", t, AT).billedUsd).toBeCloseTo(1 + 5, 12);
    expect(costFor("claude-sonnet-5", t, AT).billedUsd).toBeCloseTo(2 + 10, 12);
  });

  it("freezes the long-context card with the rest of the table", () => {
    const long = PRICING["claude-haiku-5-5"].longContext!;
    expect(Object.isFrozen(long)).toBe(true);
    expect(Object.isFrozen(long.rate)).toBe(true);
  });

  it("logs a long call at the long-context price", () => {
    const t = tk({ inputTokens: 200_000, outputTokens: 100 });
    const line = formatCallLine({ stage: "triage", model: "claude-haiku-5-5", tokens: t }, AT);
    expect(line).toContain(`$${usd(LONG, t).toFixed(6)}`);
  });
});

describe("summarizeUsage chooses the card per call", () => {
  it("prices many short calls at the short card even when their sum passes 100K", () => {
    const one = tk({ inputTokens: 1_000, outputTokens: 50 });
    const calls: RecordedCall[] = Array.from({ length: 200 }, () => ({
      stage: "triage",
      model: "claude-haiku-5-5",
      tokens: one,
    }));
    const s = summarizeUsage(calls, AT);
    expect(s.stages[0].tokens.inputTokens).toBe(200_000);
    expect(s.totalBilledUsd).toBeCloseTo(200 * usd(SHORT, one), 12);
  });

  it("prices each call of a mixed group on its own card", () => {
    const short = tk({ inputTokens: 5_000, outputTokens: 100 });
    const long = tk({ inputTokens: 150_000, outputTokens: 100 });
    const s = summarizeUsage(
      [
        { stage: "expand", model: "claude-haiku-5-5", tokens: short },
        { stage: "expand", model: "claude-haiku-5-5", tokens: long },
      ],
      AT
    );
    expect(s.stages).toHaveLength(1);
    expect(s.stages[0].tokens.inputTokens).toBe(155_000);
    expect(s.stages[0].cost.billedUsd).toBeCloseTo(usd(SHORT, short) + usd(LONG, long), 12);
    expect(s.stages[0].cost.listUsd).toBeCloseTo(usd(SHORT, short) + usd(LONG, long), 12);
  });

  it("refuses to price a model that carries both a promotion and a long-context card", () => {
    const both: Record<TrackedModel, ModelPricing> = {
      ...PRICING,
      "claude-haiku-5-5": {
        ...PRICING["claude-haiku-5-5"],
        promo: { rate: PRICING["claude-haiku-5-5"].list, fromUtcDate: "2026-01-01", throughUtcDate: "2026-12-31" },
      },
    };
    const s = summarizeUsage(
      [{ stage: "triage", model: "claude-haiku-5-5", tokens: tk({ inputTokens: 150_000 }) }],
      AT,
      both
    );
    expect(s.unpricedModels).toEqual(["claude-haiku-5-5"]);
  });
});

describe("a call with no usage settles at its byte bound on the right card", () => {
  const bounded = (requestBytes: number): RecordedCall => ({
    stage: "expand",
    model: "claude-haiku-5-5",
    tokens: null,
    bound: { requestBytes, maxOutputTokens: 1_000, attempts: 1 },
  });

  it("uses the short card while bytes plus overhead stay at 100K or under", () => {
    const bytes = 100_000 - REQUEST_OVERHEAD_TOKENS;
    const s = summarizeUsage([bounded(bytes)], AT);
    expect(s.unmeasuredBoundUsd).toBeCloseTo(usd(SHORT, tk({ inputTokens: 100_000, outputTokens: 1_000 })), 15);
  });

  it("uses the long-context card one byte past that", () => {
    const bytes = 100_000 - REQUEST_OVERHEAD_TOKENS + 1;
    const s = summarizeUsage([bounded(bytes)], AT);
    expect(s.unmeasuredBoundUsd).toBeCloseTo(usd(LONG, tk({ inputTokens: 100_001, outputTokens: 1_000 })), 15);
  });

  it("multiplies by the attempts the client may make", () => {
    const call: RecordedCall = {
      stage: "triage",
      model: "claude-haiku-5-5",
      tokens: null,
      bound: { requestBytes: 300_000, maxOutputTokens: 2_000, attempts: 3 },
    };
    const one = usd(LONG, tk({ inputTokens: 300_000 + REQUEST_OVERHEAD_TOKENS, outputTokens: 2_000 }));
    expect(summarizeUsage([call], AT).unmeasuredBoundUsd).toBeCloseTo(3 * one, 12);
  });
});
