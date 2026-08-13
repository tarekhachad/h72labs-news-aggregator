import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster } from "@/types";

// Same fake-Anthropic-constructor pattern as triage.test.ts/dedup.test.ts —
// writeCard's generateSummary is the only thing in writeCard.ts that talks
// to Anthropic, fully controlled via this shared mock.
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeCluster(): Cluster {
  return {
    topic: "Tech/AI",
    articles: [
      {
        title: "A title",
        snippet: "A snippet",
        url: "https://example.com/a",
        source: "BBC",
        topic: "Tech/AI",
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
}

beforeEach(() => {
  mockParse.mockReset();
});

describe("writeCard prompt input", () => {
  // This was the only prompt builder in the app without a per-article cap,
  // and the Final Phase measured the consequence: input reaching 5,142
  // tokens against a median of 871.
  it("caps each article's snippet rather than sending it whole", async () => {
    mockParse.mockResolvedValue({
      parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] },
      stop_reason: "end_turn",
    });
    const cluster = makeCluster();
    cluster.articles[0].snippet = "x".repeat(50_000);
    const { writeCard } = await import("@/lib/writeCard");

    await writeCard(cluster, 4);

    const sent = mockParse.mock.calls[0][0].messages[0].content as string;
    expect(sent.length).toBeLessThan(5_000);
    // ...but still generous enough to actually write from.
    expect(sent).toContain("x".repeat(1_000));
  });
});

describe("writeCard", () => {
  it("passes through title/shortSummary/labels/severity from a real Sonnet response", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        title: "Anthropic Ships New Chip Design",
        shortSummary: "A complete-looking summary paragraph.",
        labels: ["Chips", "Anthropic"],
      },
      stop_reason: "end_turn",
    });
    const { writeCard } = await import("@/lib/writeCard");

    const card = await writeCard(makeCluster(), 4);

    expect(card.title).toBe("Anthropic Ships New Chip Design");
    expect(card.shortSummary).toBe("A complete-looking summary paragraph.");
    expect(card.labels).toEqual(["Chips", "Anthropic"]);
    expect(card.severity).toBe(4);
  });

  it("throws when parsed_output is missing (empty shortSummary is never salvageable)", async () => {
    mockParse.mockResolvedValue({ parsed_output: null, stop_reason: "end_turn" });
    const { writeCard } = await import("@/lib/writeCard");

    await expect(writeCard(makeCluster(), 3)).rejects.toThrow(/empty output/);
  });

  it("trims a title and filters out whitespace-only labels defensively, without failing the whole card", async () => {
    // Proves the JS-level transform itself (generateSummary's .trim()/
    // .filter()) and that no spurious retry fires for this non-truncation
    // case. Does NOT, on its own, prove the round-2 regression (a zod
    // .trim().min(1) throwing out of client.messages.parse() with no
    // retry) stays fixed — mockParse fully replaces the SDK call, so the
    // real CardSummary schema is never actually exercised here. See the
    // dedicated "CardSummary schema" describe block below for that.
    mockParse.mockResolvedValue({
      parsed_output: {
        title: "  Padded Title With Whitespace  ",
        shortSummary: "A complete-looking summary paragraph.",
        labels: ["  Real Label  ", "   "],
      },
      stop_reason: "end_turn",
    });
    const { writeCard } = await import("@/lib/writeCard");

    const card = await writeCard(makeCluster(), 3);

    expect(mockParse).toHaveBeenCalledTimes(1); // no retry needed — this isn't a truncation case
    expect(card.title).toBe("Padded Title With Whitespace");
    expect(card.labels).toEqual(["Real Label"]);
  });

  it("carries the RETRY attempt's title/labels through, not the initial attempt's, when the initial looks truncated", async () => {
    // First call: shortSummary doesn't end in sentence-ending punctuation
    // (looksComplete() returns false) with stop_reason "end_turn" — the
    // one genuinely-ambiguous case generateWithRetryOnAmbiguousTruncation
    // retries rather than throwing immediately. This is the exact
    // regression risk the claudeText.ts generic refactor exists to
    // close: before that refactor, only the retry's *text* would have
    // survived — its title/labels would have been silently discarded in
    // favor of whatever the (unused) initial attempt happened to produce.
    mockParse
      .mockResolvedValueOnce({
        parsed_output: {
          title: "Initial Attempt Title",
          shortSummary: "An incomplete-looking summary that just trails off",
          labels: ["InitialLabel"],
        },
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({
        parsed_output: {
          title: "Retry Attempt Title",
          shortSummary: "A complete-looking summary from the retry.",
          labels: ["RetryLabel"],
        },
        stop_reason: "end_turn",
      });
    const { writeCard } = await import("@/lib/writeCard");

    const card = await writeCard(makeCluster(), 2);

    expect(mockParse).toHaveBeenCalledTimes(2);
    expect(card.title).toBe("Retry Attempt Title");
    expect(card.shortSummary).toBe("A complete-looking summary from the retry.");
    expect(card.labels).toEqual(["RetryLabel"]);
  });

  it("does not catch a thrown Anthropic error itself — fail-closed handling is the caller's job", async () => {
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { writeCard } = await import("@/lib/writeCard");

    await expect(writeCard(makeCluster(), 3)).rejects.toThrow("rate limited");
  });
});

describe("CardSummary schema", () => {
  // Round-2 code review found that a per-string `.trim().min(1)` on
  // title/labels made zodOutputFormat(CardSummary) reject a
  // whitespace-padded value INSIDE client.messages.parse() itself —
  // before generateWithRetryOnAmbiguousTruncation's retry-once logic
  // ever ran, hard-failing the whole card with no retry. The other
  // describe block's tests all go through a fully-mocked Anthropic
  // client, which never actually calls CardSummary.safeParse — so none
  // of them can prove this regression stays fixed. This asserts against
  // the real, exported schema directly.
  it("accepts a whitespace-padded title and a whitespace-only label — the schema itself must not reject these, only generateSummary's own JS-level trim/filter should handle them", async () => {
    const { CardSummary } = await import("@/lib/writeCard");

    const result = CardSummary.safeParse({
      title: "  Padded Title  ",
      shortSummary: "A summary.",
      labels: ["Real Label", "   "],
    });

    expect(result.success).toBe(true);
    // The schema itself does no trimming — parsed values come through
    // exactly as given. Confirms this isn't accidentally passing because
    // some other transform quietly normalized the input before this
    // assertion ran.
    if (result.success) {
      expect(result.data.title).toBe("  Padded Title  ");
      expect(result.data.labels).toEqual(["Real Label", "   "]);
    }
  });

  it("still rejects a genuinely malformed shape (labels array too long)", async () => {
    const { CardSummary } = await import("@/lib/writeCard");

    const result = CardSummary.safeParse({
      title: "A Real Title",
      shortSummary: "A summary.",
      labels: ["One", "Two", "Three"],
    });

    expect(result.success).toBe(false);
  });
});
