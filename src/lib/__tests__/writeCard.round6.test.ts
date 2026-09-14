/** Killing tests for writeCard mutants that survive an ordinary sweep. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster } from "@/types";

const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() { return { messages: { parse: mockParse } }; }
  return { default: FakeAnthropic };
});

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockResolvedValue({
    parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] },
    stop_reason: "end_turn",
  });
});

type Article = Cluster["articles"][number];
const article = (p: Partial<Article> = {}): Article => ({
  title: "A title", snippet: "A snippet", url: "https://example.com/a",
  source: "BBC", topic: "Tech/AI", publishedAt: "2026-07-31T12:00:00Z", ...p,
});

describe("G-M0161: a freshly written card is never already bookmarked", () => {
  it("writeCard returns bookmarked=false", async () => {
    const { writeCard } = await import("@/lib/writeCard");
    const card = await writeCard({ topic: "Tech/AI", articles: [article()] }, 4);
    expect(card.bookmarked).toBe(false);
  });
});

describe("G-M0160: publishedAt picks the freshest article, ties going to the earlier entry", () => {
  it("picks the strictly-later timestamp regardless of input order", async () => {
    const { writeCard } = await import("@/lib/writeCard");
    const later = "2026-08-02T00:00:00Z";
    const earlier = "2026-07-31T12:00:00Z";
    const a = await writeCard({ topic: "Tech/AI", articles: [article({ publishedAt: earlier, url: "https://e.com/1" }), article({ publishedAt: later, url: "https://e.com/2" })] }, 4);
    expect(a.publishedAt).toBe(later);
    const b = await writeCard({ topic: "Tech/AI", articles: [article({ publishedAt: later, url: "https://e.com/2" }), article({ publishedAt: earlier, url: "https://e.com/1" })] }, 4);
    expect(b.publishedAt).toBe(later);
  });

  it("on an exact tie keeps the FIRST article's timestamp source, not the last", async () => {
    const { writeCard } = await import("@/lib/writeCard");
    const same = "2026-08-01T00:00:00Z";
    // Equal instants expressed differently: the reduce must not swap on a tie.
    const card = await writeCard({ topic: "Tech/AI", articles: [
      article({ publishedAt: same, url: "https://e.com/1" }),
      article({ publishedAt: "2026-08-01T00:00:00.000Z", url: "https://e.com/2" }),
    ] }, 4);
    expect(card.publishedAt).toBe(same);
  });
});
