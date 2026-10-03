import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOPICS, type Topic } from "@/types";

const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

import { buildRankPrompt, rankFrontPage, type RankCandidate } from "@/lib/rank";

const [A, B] = TOPICS as readonly Topic[];

/** What the ranker is sent, read off the mocked SDK call. */
function sentRequest() {
  const body = mockParse.mock.calls[0][0];
  return { system: body.system as string, user: body.messages[0].content as string };
}

/** The candidate line format every run used before preferred counts existed. */
const plainLine = (c: RankCandidate, i: number) => `${i}. [${c.topic}, severity ${c.severity}] ${c.text}`;

const base: RankCandidate[] = [
  { topic: A, severity: 3, text: "First story" },
  { topic: B, severity: 4, text: "Second story" },
  { topic: A, severity: 3, text: "Third story" },
];

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockResolvedValue({ parsed_output: { picks: [] } });
});

describe("rankFrontPage with preferred-source counts", () => {
  it("sends each candidate's count to the ranker", async () => {
    await rankFrontPage([
      { ...base[0], preferredSourceCount: 2 },
      { ...base[1], preferredSourceCount: 0 },
      { ...base[2], preferredSourceCount: 1 },
    ]);

    const { user } = sentRequest();
    expect(user).toContain(`0. [${A}, severity 3, preferred sources 2] First story`);
    expect(user).toContain(`1. [${B}, severity 4, preferred sources 0] Second story`);
    expect(user).toContain(`2. [${A}, severity 3, preferred sources 1] Third story`);
  });

  it("tells the ranker to favour more preferred sources between stories of similar importance", async () => {
    await rankFrontPage([{ ...base[0], preferredSourceCount: 1 }, base[1]]);

    const { system } = sentRequest();
    expect(system).toMatch(/Between stories of similar importance, rank the one covered by more of the reader's preferred sources higher/);
    expect(system).toMatch(/never let that lift a clearly less significant story/);
  });

  it("reads a missing count as zero once any candidate has one", async () => {
    await rankFrontPage([{ ...base[0], preferredSourceCount: 1 }, base[1]]);
    expect(sentRequest().user).toContain(`1. [${B}, severity 4, preferred sources 0] Second story`);
  });

  it("with zero preferences sends today's prompt exactly", async () => {
    await rankFrontPage(base);
    const legacy = sentRequest();
    mockParse.mockClear();

    await rankFrontPage(base.map((c) => ({ ...c, preferredSourceCount: 0 })));
    const zeroCounts = sentRequest();

    expect(zeroCounts).toEqual(legacy);
    expect(legacy.system).not.toMatch(/preferred/i);
    expect(legacy.user).toBe(
      `Candidate stories:\n\n${base.map(plainLine).join("\n\n")}\n\nWhich belong on today's front page, and in what order?`
    );
  });

  it("adds the note as one extra paragraph and changes nothing else in the system prompt", () => {
    const without = buildRankPrompt(base).system;
    const withCounts = buildRankPrompt([{ ...base[0], preferredSourceCount: 3 }]).system;
    expect(withCounts.startsWith(`${without}\n\n`)).toBe(true);
    expect(withCounts.slice(without.length + 2)).not.toContain("\n");
  });

  it("still truncates each summary to the same length", () => {
    const long = "x".repeat(1000);
    const { list } = buildRankPrompt([{ topic: A, severity: 2, text: long, preferredSourceCount: 1 }]);
    expect(list).toBe(`0. [${A}, severity 2, preferred sources 1] ${"x".repeat(300)}`);
  });
});
