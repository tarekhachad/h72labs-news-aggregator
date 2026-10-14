import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CHECK_CONCURRENCY,
  MAX_CANDIDATES_PER_CARD,
  MAX_CHECKS_PER_RUN,
  TIMELINE_BUDGET_MS,
  buildParams,
  linkStories,
  type StoryCandidate,
} from "@/lib/storyTimeline";
import { boundOf, createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import { settleCeilingFor } from "@/lib/usageRecord";

// Edge cases of the story matching beyond the lane's own suite: short or
// malformed model output, out-of-range answers, the deadline cutting checks
// off, and whether the calls the run expects always equal the calls it records
// (an under-record keeps a run at its full reservation).

const mocks = vi.hoisted(() => ({ parse: vi.fn(), embed: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mocks.parse }, maxRetries: 0 };
  }
  return { default: FakeAnthropic };
});

vi.mock("@/lib/embeddings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/embeddings")>("@/lib/embeddings");
  return { embed: mocks.embed, cosineSimilarity: actual.cosineSimilarity };
});

const DIM = 384;
function at(score: number, axis = 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = score;
  v[axis] = Math.sqrt(Math.max(0, 1 - score * score));
  return v;
}
const NEW = at(1);

function candidate(id: string, score: number, extra: Partial<StoryCandidate> = {}): StoryCandidate {
  return { id, storyId: `story-${id}`, date: "2026-10-10", title: `Earlier ${id}`, shortSummary: `Summary ${id}.`, embedding: at(score, 2), ...extra };
}
const card = (id: string) => ({ id, title: `Title ${id}`, shortSummary: `Summary of ${id}.` });
const answer = (match: unknown) => ({ parsed_output: { match }, stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 7 } });

beforeEach(() => {
  mocks.parse.mockReset();
  mocks.embed.mockReset();
  mocks.embed.mockImplementation(async (texts: string[]) => texts.map(() => NEW));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("linkStories, odd model output", () => {
  it("survives the model returning fewer vectors than cards: the short ones are their own story with no embedding", async () => {
    mocks.embed.mockImplementation(async () => [NEW]);
    mocks.parse.mockResolvedValue(answer(1));
    const result = await linkStories([card("a"), card("b"), card("c")], "2026-10-13", [candidate("x", 0.9)]);
    expect(result.links.get("a")).toEqual({ embedding: NEW, storyId: "story-x" });
    expect(result.links.get("b")).toEqual({ embedding: null, storyId: "b" });
    expect(result.links.get("c")).toEqual({ embedding: null, storyId: "c" });
    expect(result.haikuCalls).toBe(1);
  });

  it("keeps no embedding with a NaN in it, and asks nothing for that card", async () => {
    const bad = [...NEW];
    bad[10] = Number.NaN;
    mocks.embed.mockImplementation(async () => [bad, NEW]);
    mocks.parse.mockResolvedValue(answer(1));
    const result = await linkStories([card("a"), card("b")], "2026-10-13", [candidate("x", 0.9)]);
    expect(result.links.get("a")).toEqual({ embedding: null, storyId: "a" });
    expect(result.links.get("b")?.storyId).toBe("story-x");
    expect(mocks.parse).toHaveBeenCalledTimes(1);
  });
});

describe("linkStories, Haiku's answer", () => {
  it.each([0, -1, 2, 4, 1.5, "1", null])("treats an answer of %s (one candidate) as no match", async (match) => {
    mocks.parse.mockResolvedValue(answer(match));
    const result = await linkStories([card("a")], "2026-10-13", [candidate("x", 0.9)]);
    expect(result.links.get("a")?.storyId).toBe("a");
    expect(result.linked).toBe(0);
    expect(result.haikuCalls).toBe(1);
  });

  it("an out-of-range answer for one card leaves the other cards' checks to finish and link", async () => {
    mocks.parse.mockImplementation(async (params: { messages: { content: string }[] }) => {
      if (params.messages[0].content.includes("Title a.")) return answer(4);
      await new Promise((r) => setTimeout(r, 5));
      return answer(1);
    });
    const result = await linkStories([card("a"), card("b")], "2026-10-13", [candidate("x", 0.9)]);
    expect(result.links.get("a")?.storyId).toBe("a");
    expect(result.links.get("b")?.storyId).toBe("story-x");
    expect(result.linked).toBe(1);
    expect(result.haikuCalls).toBe(2);
  });

  it("treats a missing parsed_output (a refusal or a cut-off answer) as no match", async () => {
    mocks.parse.mockResolvedValue({ parsed_output: null, stop_reason: "max_tokens", usage: { input_tokens: 700, output_tokens: 32 } });
    const result = await linkStories([card("a")], "2026-10-13", [candidate("x", 0.9)]);
    expect(result.links.get("a")?.storyId).toBe("a");
  });

  it("maps answer N to the Nth candidate shown, best story first", async () => {
    mocks.parse.mockResolvedValue(answer(3));
    const candidates = [candidate("low", 0.5), candidate("top", 0.95), candidate("mid", 0.7), candidate("mid2", 0.69, { storyId: "story-mid" })];
    const result = await linkStories([card("a")], "2026-10-13", candidates);
    const prompt = mocks.parse.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toMatch(/1\. 2026-10-10: Earlier top\./);
    expect(prompt).toMatch(/2\. 2026-10-10: Earlier mid\./);
    expect(prompt).toMatch(/3\. 2026-10-10: Earlier low\./);
    expect(prompt).not.toMatch(/Earlier mid2/);
    expect(result.links.get("a")?.storyId).toBe("story-low");
  });

  it("links two new cards of one run to the same earlier story", async () => {
    mocks.parse.mockResolvedValue(answer(1));
    const result = await linkStories([card("a"), card("b")], "2026-10-13", [candidate("x", 0.9)]);
    expect(result.links.get("a")?.storyId).toBe("story-x");
    expect(result.links.get("b")?.storyId).toBe("story-x");
    expect(result.linked).toBe(2);
  });
});

describe("linkStories, budget and spend accounting", () => {
  it("records exactly the calls it reports, even when the deadline cuts checks off, so the run is never under-recorded", async () => {
    vi.useFakeTimers();
    mocks.parse.mockImplementation(
      (_params: unknown, { timeout }: { timeout: number }) =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout))
    );
    const usage = createUsageCollector(new Date("2026-10-13T12:00:00Z"));
    const cards = Array.from({ length: 60 }, (_, i) => card(`c${i}`));
    const done = withUsageCollector(usage, () => linkStories(cards, "2026-10-13", [candidate("x", 0.9)]));
    await vi.advanceTimersByTimeAsync(TIMELINE_BUDGET_MS + 1000);
    const result = await done;
    expect(result.haikuCalls).toBe(CHECK_CONCURRENCY * 2);
    expect(usage.calls().filter((c) => c.stage === "timeline")).toHaveLength(result.haikuCalls);
    // Every abandoned call carries a ceiling, so the run settles at a proven figure, not the whole reservation.
    const ceiling = settleCeilingFor(usage.summarize(), { timeline: result.haikuCalls });
    expect(ceiling).not.toBeNull();
  });

  it("starts no check when the earlier-cards read lands after the budget, but keeps every embedding", async () => {
    vi.useFakeTimers();
    const late = new Promise<StoryCandidate[]>((resolve) => setTimeout(() => resolve([candidate("x", 0.9)]), TIMELINE_BUDGET_MS + 500));
    const done = linkStories([card("a")], "2026-10-13", late);
    await vi.advanceTimersByTimeAsync(TIMELINE_BUDGET_MS + 1000);
    const result = await done;
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(result.links.get("a")).toEqual({ embedding: NEW, storyId: "a" });
  });

  it("bounds the settle ceiling of one unit's worth of failed checks inside one unit's reservation", () => {
    // Every field at its clip limit (plain text: a card's title and summary are written by writeCard).
    const long = "word ".repeat(2000);
    const earlier = Array.from({ length: MAX_CANDIDATES_PER_CARD }, (_, i) => candidate(`w${i}`, 0.9, { title: long, shortSummary: long }));
    const bound = boundOf(buildParams({ title: long, shortSummary: long }, "2026-10-13", earlier), 1)!;
    const usage = createUsageCollector(new Date("2026-10-13T12:00:00Z"));
    const perUnit = MAX_CHECKS_PER_RUN / 10;
    for (let i = 0; i < perUnit; i++) usage.add({ stage: "timeline", model: "claude-haiku-4-5", tokens: null, bound });
    const usd = usage.summarize().unmeasuredBoundUsd!;
    // spend_config.digest_per_topic_usd is 0.065.
    expect(usd).toBeLessThan(0.065);
  });
});
