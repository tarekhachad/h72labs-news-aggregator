import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MODELS, requestFor } from "@/lib/models";
import {
  CHECK_CONCURRENCY,
  MAX_CANDIDATES_PER_CARD,
  MAX_CHECKS_PER_RUN,
  STORY_CANDIDATE_THRESHOLD,
  TIMELINE_BUDGET_MS,
  buildParams,
  daysBefore,
  linkStories,
  loadStoryCandidates,
  storyText,
  topStories,
  type StoryCandidate,
} from "@/lib/storyTimeline";
import { boundOf, createUsageCollector, withUsageCollector } from "@/lib/usageCollector";

// The story timeline's matching, with no model loaded and no call made:
// embed() hands back vectors built so each candidate's similarity to the new
// card is exactly the score a test needs, and Haiku is a stub.

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
/** A unit vector whose similarity to NEW is `score`. */
function at(score: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = score;
  v[1] = Math.sqrt(Math.max(0, 1 - score * score));
  return v;
}
const NEW = at(1);

function candidate(id: string, score: number, extra: Partial<StoryCandidate> = {}): StoryCandidate {
  return { id, storyId: `story-${id}`, date: "2026-10-10", title: `Earlier ${id}`, shortSummary: `Summary ${id}.`, embedding: at(score), ...extra };
}

const card = (id: string) => ({ id, title: `Title ${id}`, shortSummary: `Summary of ${id}.` });

function answer(match: number) {
  return { parsed_output: { match }, stop_reason: "end_turn", usage: { input_tokens: 700, output_tokens: 7 } };
}

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

describe("storyText", () => {
  it("is the title and the short summary, trimmed", () => {
    expect(storyText("  Talks open  ", " Negotiators met. ")).toBe("Talks open. Negotiators met.");
  });

  it("is the summary alone for a card with no title", () => {
    expect(storyText("", "Negotiators met.")).toBe("Negotiators met.");
  });

  it("is bounded", () => {
    expect(Array.from(storyText("t", "x".repeat(5000))).length).toBe(1000);
  });
});

describe("daysBefore", () => {
  it("counts calendar days across month and year ends", () => {
    expect(daysBefore("2026-10-13", 30)).toBe("2026-09-13");
    expect(daysBefore("2026-03-01", 1)).toBe("2026-02-28");
    expect(daysBefore("2026-01-15", 30)).toBe("2025-12-16");
  });
});

describe("topStories", () => {
  it("keeps only stories at or above the threshold, best first, at most three", () => {
    const picked = topStories(NEW, [
      candidate("a", 0.6),
      candidate("b", STORY_CANDIDATE_THRESHOLD),
      candidate("c", STORY_CANDIDATE_THRESHOLD - 0.01),
      candidate("d", 0.9),
      candidate("e", 0.7),
    ]);
    expect(picked.map((c) => c.id)).toEqual(["d", "e", "a"]);
    expect(picked).toHaveLength(MAX_CANDIDATES_PER_CARD);
  });

  it("takes one card per story, so several days of one story fill one place", () => {
    const picked = topStories(NEW, [
      candidate("a1", 0.9, { storyId: "S" }),
      candidate("a2", 0.8, { storyId: "S" }),
      candidate("b", 0.7),
    ]);
    expect(picked.map((c) => c.id)).toEqual(["a1", "b"]);
  });

  it("treats a card with no story as a story of its own", () => {
    const picked = topStories(NEW, [candidate("a", 0.8, { storyId: null }), candidate("b", 0.7, { storyId: null })]);
    expect(picked.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("buildParams", () => {
  it("numbers the earlier cards from 1 with their dates, and states the rule", () => {
    const params = buildParams(card("n"), "2026-10-13", [candidate("a", 0.9), candidate("b", 0.8, { date: "2026-10-11" })]);
    const text = params.messages[0].content;
    expect(text).toContain("1. 2026-10-10: Earlier a. Summary a.");
    expect(text).toContain("2. 2026-10-11: Earlier b. Summary b.");
    expect(text).toContain("New card (2026-10-13): Title n. Summary of n.");
    expect(params.model).toBe(MODELS.timeline);
    expect(params.system).toMatch(/follow-up/);
    expect(params.system).toMatch(/related but separate events/i);
    expect(params.system).toMatch(/When in doubt, answer 0/);
  });

  // The lane report's spend arithmetic rests on these three numbers. Raising
  // any of them changes the worst-case run, which must be re-checked against
  // the $0.70 hold before this test is edited.
  it("bounds one check's size and the run's number of checks", () => {
    const long = "word ".repeat(2000);
    const worst = buildParams({ title: long, shortSummary: long }, "2026-10-13", [1, 2, 3].map((i) => candidate(String(i), 0.9, { title: long, shortSummary: long })));
    const bound = boundOf(worst, 1)!;
    expect(bound.requestBytes).toBeLessThanOrEqual(3400);
    expect(bound.maxOutputTokens).toBeLessThanOrEqual(requestFor(MODELS.timeline, { max_tokens: 32, messages: [] }).max_tokens);
    expect(MAX_CHECKS_PER_RUN).toBeLessThanOrEqual(80);
  });
});

describe("linkStories", () => {
  it("gives every card its embedding and its own story when there are no earlier cards", async () => {
    for (const earlier of [null, []]) {
      const result = await linkStories([card("x"), card("y")], "2026-10-13", earlier);
      expect(result.links.get("x")).toEqual({ embedding: NEW, storyId: "x" });
      expect(result.links.get("y")).toEqual({ embedding: NEW, storyId: "y" });
      expect(result.haikuCalls).toBe(0);
    }
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("embeds title and short summary, as the backfill does", async () => {
    await linkStories([card("x")], "2026-10-13", []);
    expect(mocks.embed).toHaveBeenCalledWith(["Title x. Summary of x."]);
  });

  it("joins the story Haiku picks", async () => {
    mocks.parse.mockResolvedValue(answer(2));
    const result = await linkStories([card("x")], "2026-10-13", [candidate("a", 0.9), candidate("b", 0.8)]);
    expect(result.links.get("x")).toEqual({ embedding: NEW, storyId: "story-b" });
    expect(result).toMatchObject({ haikuCalls: 1, linked: 1 });
  });

  it("lends a matched card's own id when it has no story yet", async () => {
    mocks.parse.mockResolvedValue(answer(1));
    const result = await linkStories([card("x")], "2026-10-13", [candidate("a", 0.9, { storyId: null })]);
    expect(result.links.get("x")?.storyId).toBe("a");
  });

  it.each([
    ["no match", () => mocks.parse.mockResolvedValue(answer(0))],
    ["a number past the list", () => mocks.parse.mockResolvedValue(answer(4))],
    ["a negative number", () => mocks.parse.mockResolvedValue(answer(-1))],
    ["no parsed output", () => mocks.parse.mockResolvedValue({ parsed_output: null, stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 32 } })],
    ["a failed call", () => mocks.parse.mockRejectedValue(new Error("529 overloaded"))],
  ])("leaves the card its own story on %s", async (_, arrange) => {
    arrange();
    const result = await linkStories([card("x")], "2026-10-13", [candidate("a", 0.9), candidate("b", 0.8), candidate("c", 0.7)]);
    expect(result.links.get("x")).toEqual({ embedding: NEW, storyId: "x" });
    expect(result.linked).toBe(0);
    expect(result.haikuCalls).toBe(1);
  });

  it("asks nothing for a card with no earlier story above the threshold", async () => {
    const result = await linkStories([card("x")], "2026-10-13", [candidate("a", STORY_CANDIDATE_THRESHOLD - 0.05)]);
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(result.links.get("x")?.storyId).toBe("x");
  });

  it("never rejects when embedding fails: every card is its own story, with no embedding", async () => {
    mocks.embed.mockRejectedValue(new Error("model load failed"));
    const result = await linkStories([card("x")], "2026-10-13", [candidate("a", 0.9)]);
    expect(result.links.get("x")).toEqual({ embedding: null, storyId: "x" });
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("stores no embedding that isn't 384 finite numbers", async () => {
    mocks.embed.mockResolvedValue([[0.1, 0.2], [...NEW.slice(0, 383), Number.NaN]]);
    const result = await linkStories([card("x"), card("y")], "2026-10-13", [candidate("a", 0.9)]);
    expect(result.links.get("x")).toEqual({ embedding: null, storyId: "x" });
    expect(result.links.get("y")).toEqual({ embedding: null, storyId: "y" });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("logs failed checks once, however many failed", async () => {
    mocks.parse.mockRejectedValue(new Error("boom"));
    await linkStories([card("x"), card("y"), card("z")], "2026-10-13", [candidate("a", 0.9)]);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("treats a rejected earlier-cards read as none", async () => {
    const result = await linkStories([card("x")], "2026-10-13", Promise.reject(new Error("db down")));
    expect(result.links.get("x")).toEqual({ embedding: NEW, storyId: "x" });
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("caps the run's checks and keeps at most CHECK_CONCURRENCY in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.parse.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return answer(1);
    });
    const cards = Array.from({ length: MAX_CHECKS_PER_RUN + 5 }, (_, i) => card(`c${i}`));
    const result = await linkStories(cards, "2026-10-13", [candidate("a", 0.9)]);
    expect(mocks.parse).toHaveBeenCalledTimes(MAX_CHECKS_PER_RUN);
    expect(result.haikuCalls).toBe(MAX_CHECKS_PER_RUN);
    expect(peak).toBe(CHECK_CONCURRENCY);
    expect(result.links.get(`c${MAX_CHECKS_PER_RUN}`)?.storyId).toBe(`c${MAX_CHECKS_PER_RUN}`);
    expect(result.links.get("c0")?.storyId).toBe("story-a");
  });

  it("passes each call a timeout that ends by the deadline", async () => {
    mocks.parse.mockResolvedValue(answer(0));
    await linkStories([card("x")], "2026-10-13", [candidate("a", 0.9)]);
    const [, options] = mocks.parse.mock.calls[0];
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(TIMELINE_BUDGET_MS);
  });

  it("starts no check after the budget runs out, and waits for no hung read past it", async () => {
    vi.useFakeTimers();
    // A call that ends only at its own timeout, as the SDK's would.
    mocks.parse.mockImplementation(
      (_params: unknown, { timeout }: { timeout: number }) =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout))
    );
    const cards = Array.from({ length: 40 }, (_, i) => card(`c${i}`));
    const done = linkStories(cards, "2026-10-13", [candidate("a", 0.9)]);
    await vi.advanceTimersByTimeAsync(TIMELINE_BUDGET_MS + 1000);
    const result = await done;
    // 16 start at once and time out at 4 s, 16 more start and end at the 8 s
    // deadline, and nothing starts after it.
    expect(result.haikuCalls).toBe(CHECK_CONCURRENCY * 2);
    expect([...result.links.values()].every((link, i) => link.storyId === `c${i}`)).toBe(true);

    mocks.parse.mockReset();
    const hung = linkStories([card("x")], "2026-10-13", new Promise<null>(() => {}));
    await vi.advanceTimersByTimeAsync(TIMELINE_BUDGET_MS + 1);
    expect((await hung).links.get("x")).toEqual({ embedding: NEW, storyId: "x" });
  });

  it("waits for every check still out even when linking one card throws", async () => {
    let reads = 0;
    const trap = candidate("a", 0.9);
    Object.defineProperty(trap, "storyId", {
      get() {
        reads += 1;
        if (reads > 2) throw new Error("bad candidate");
        return "story-a";
      },
    });
    let slowFinished = false;
    mocks.parse
      .mockResolvedValueOnce(answer(1))
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 30));
        slowFinished = true;
        return answer(0);
      });
    const result = await linkStories([card("x"), card("y")], "2026-10-13", [trap]);
    expect(slowFinished).toBe(true);
    expect(result.links.get("x")?.storyId).toBe("x");
    expect(result.haikuCalls).toBe(2);
  });

  it("records each check under the timeline stage, with a ceiling", async () => {
    mocks.parse.mockResolvedValueOnce(answer(1)).mockRejectedValueOnce(new Error("boom"));
    const usage = createUsageCollector(new Date("2026-10-13T12:00:00Z"));
    await withUsageCollector(usage, () => linkStories([card("x"), card("y")], "2026-10-13", [candidate("a", 0.9)]));
    const calls = usage.calls();
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.stage === "timeline" && c.model === MODELS.timeline)).toBe(true);
    expect(calls.filter((c) => c.tokens !== null)).toHaveLength(1);
    expect(calls.find((c) => c.tokens === null)?.bound).toMatchObject({ maxOutputTokens: requestFor(MODELS.timeline, { max_tokens: 32, messages: [] }).max_tokens, attempts: 1 });
  });

  it("treats a refusal as no match, even one carrying a match, and logs each one once with its category", async () => {
    const refused = {
      parsed_output: { match: 1 },
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
      usage: { input_tokens: 700, output_tokens: 2 },
    };
    mocks.parse.mockResolvedValue(refused);
    const usage = createUsageCollector(new Date("2026-10-13T12:00:00Z"));
    const result = await withUsageCollector(usage, () =>
      linkStories([card("x"), card("y")], "2026-10-13", [candidate("a", 0.9)])
    );
    expect(result.linked).toBe(0);
    expect(result.links.get("x")?.storyId).toBe("x");
    expect(result.links.get("y")?.storyId).toBe("y");
    const warn = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("refused"));
    expect(warn).toEqual([
      "[timeline] timeline refused by the model (category: cyber); this card starts its own story",
      "[timeline] timeline refused by the model (category: cyber); this card starts its own story",
    ]);
    // Not counted again among the failures, whose line prints only the first error.
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes("story check(s) failed"))).toBe(false);
    // Both refused calls completed, so their usage is measured.
    expect(usage.calls().map((c) => c.tokens?.inputTokens)).toEqual([700, 700]);
  });
});

describe("loadStoryCandidates", () => {
  function fakeClient(result: { data: unknown; error: { message: string } | null }) {
    const calls: [string, ...unknown[]][] = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "lt", "not", "order", "limit"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push([method, ...args]);
        return method === "limit" ? Promise.resolve(result) : builder;
      };
    }
    return { client: { from: (table: string) => (calls.push(["from", table]), builder) }, calls };
  }

  it("reads the reader's own cards from the 30 days before today, newest first, never today's", async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    await loadStoryCandidates(client as never, "user-1", "2026-10-13");
    expect(calls).toContainEqual(["from", "cards"]);
    expect(calls).toContainEqual(["eq", "digests.user_id", "user-1"]);
    expect(calls).toContainEqual(["gte", "digests.date", "2026-09-13"]);
    expect(calls).toContainEqual(["lt", "digests.date", "2026-10-13"]);
    expect(calls).toContainEqual(["not", "embedding", "is", null]);
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(calls.find((c) => c[0] === "limit")?.[1]).toBe(1000);
  });

  it("maps rows and skips any without a usable embedding or date", async () => {
    const good = { id: "a", story_id: "S", title: "T", short_summary: "Sum", embedding: at(0.5), digests: { date: "2026-10-12" } };
    const { client } = fakeClient({
      data: [
        good,
        { ...good, id: "b", story_id: null },
        { ...good, id: "c", embedding: [1, 2] },
        { ...good, id: "d", digests: null },
        { ...good, id: "e", embedding: "nope" },
      ],
      error: null,
    });
    const rows = await loadStoryCandidates(client as never, "user-1", "2026-10-13");
    expect(rows.map((r) => [r.id, r.storyId, r.date])).toEqual([
      ["a", "S", "2026-10-12"],
      ["b", null, "2026-10-12"],
    ]);
  });

  it("throws on a failed read, for the caller to fail open", async () => {
    const { client } = fakeClient({ data: null, error: { message: "boom" } });
    await expect(loadStoryCandidates(client as never, "user-1", "2026-10-13")).rejects.toThrow("loadStoryCandidates: boom");
  });
});
