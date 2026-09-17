import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Article } from "@/types";

// A production run died in clustering, out of memory, holding a feed item of
// 48,191 characters. A transformer pads every text in a batch to the longest
// one and attention memory grows with the square of that length, so one
// unbounded item decides the cost of its whole batch. Dedup and triage have
// always bounded the snippet they use; clustering did not, and this pins the
// bound that closes it.

const mocks = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return { ...actual, embed: mocks.embed };
});

import { clusterArticles } from "@/lib/cluster";

const TITLE_PREFIX = "A headline. ";

function article(overrides: Partial<Article>): Article {
  return {
    title: "A headline",
    snippet: "a snippet",
    url: "https://example.com/1",
    source: "BBC",
    topic: "Tech/AI",
    publishedAt: "2026-09-17T12:00:00Z",
    ...overrides,
  };
}

/** The texts clusterArticles actually handed to the model. */
function embedded(): string[] {
  return mocks.embed.mock.calls[0][0] as string[];
}

beforeEach(() => {
  mocks.embed.mockReset();
  mocks.embed.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0]));
});

describe("clustering bounds what it embeds", () => {
  it("clips an unbounded snippet to 1000 characters", async () => {
    await clusterArticles([article({ snippet: "x".repeat(48191) })]);

    const texts = embedded();
    expect(texts).toHaveLength(1);
    // The title survives; only the snippet is clipped.
    expect(texts[0].startsWith(TITLE_PREFIX)).toBe(true);
    expect(texts[0]).toHaveLength(TITLE_PREFIX.length + 1000);
  });

  it("leaves a normal article untouched", async () => {
    const snippet = "Morocco's central bank held rates steady at its September meeting.";
    await clusterArticles([article({ snippet })]);

    expect(embedded()[0]).toBe(`${TITLE_PREFIX}${snippet}`);
  });

  it("clips every article in the batch, not just the first", async () => {
    await clusterArticles([
      article({ snippet: "y".repeat(5000), url: "https://example.com/1" }),
      article({ snippet: "z".repeat(5000), url: "https://example.com/2" }),
    ]);

    const texts = embedded();
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text).toHaveLength(TITLE_PREFIX.length + 1000);
  });
});
