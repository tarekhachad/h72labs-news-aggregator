import { describe, it, expect, vi, beforeEach } from "vitest";

// Every page "blocked": the writer gets exactly the snippet-only prompt, and
// nothing in this file can reach the live web.
vi.mock("@/lib/extract", async (importOriginal) => {
  const blocked = async (urls: readonly string[]) =>
    urls.map((url) => ({ url, ok: false as const, reason: "robots" as const }));
  return {
    ...(await importOriginal<typeof import("@/lib/extract")>()),
    extractArticles: blocked,
    extractForStory: blocked,
  };
});
import { SOURCES, TOPICS, type Cluster, type Source, type Topic } from "@/types";

const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

import { buildWriteCardContent, writeCard } from "@/lib/writeCard";
import { generateExpandedReport } from "@/lib/cards";

const TOPIC = TOPICS[0] as Topic;
const [PICKED, PICKED_TOO, OTHER, OTHER_TOO] = SOURCES.slice(0, 4) as Source[];

/** Articles in this order: OTHER, PICKED, OTHER_TOO, PICKED_TOO. */
function makeCluster(): Cluster {
  const sources = [OTHER, PICKED, OTHER_TOO, PICKED_TOO];
  return {
    topic: TOPIC,
    articles: sources.map((source, i) => ({
      title: `Title ${i}`,
      snippet: `Snippet ${i}`,
      url: `https://example.com/${i}`,
      source,
      topic: TOPIC,
      // The freshest is the first, non-preferred article.
      publishedAt: `2026-10-02T1${9 - i}:00:00Z`,
    })),
  };
}

function okResponse() {
  return {
    parsed_output: { title: "T", shortSummary: "A complete sentence.", labels: ["Tag"] },
    stop_reason: "end_turn",
  };
}

const sentContent = (call = 0) => mockParse.mock.calls[call][0].messages[0].content as string;

/** Order in which "Title N" headings appear in a prompt. */
function titleOrder(prompt: string): number[] {
  return [...prompt.matchAll(/Title: Title (\d)/g)].map((m) => Number(m[1]));
}

beforeEach(() => {
  mockParse.mockReset();
  mockParse.mockResolvedValue(okResponse());
});

describe("writeCard with preferred sources", () => {
  it("lists the preferred outlets' articles first in the prompt, stable otherwise", async () => {
    await writeCard(makeCluster(), 3, [PICKED, PICKED_TOO]);
    expect(titleOrder(sentContent())).toEqual([1, 3, 0, 2]);
  });

  it("tells the writer to lead with them, naming only the ones present", async () => {
    await writeCard(makeCluster(), 3, [PICKED_TOO, PICKED, SOURCES[10] as Source]);
    const content = sentContent();
    expect(content).toContain(
      `The reader's preferred sources for this story are listed first (${PICKED}, ${PICKED_TOO}): lead with their reporting and use the other sources to fill gaps.`
    );
    expect(content.indexOf("lead with their reporting")).toBeLessThan(content.indexOf("Source: "));
  });

  it("puts them first in Card.sources too", async () => {
    const card = await writeCard(makeCluster(), 3, [PICKED, PICKED_TOO]);
    expect(card.sources.map((s) => s.source)).toEqual([PICKED, PICKED_TOO, OTHER, OTHER_TOO]);
    expect(card.sources.map((s) => s.url)).toEqual([1, 3, 0, 2].map((i) => `https://example.com/${i}`));
  });

  it("keeps the card's own facts: publishedAt is still the freshest article's", async () => {
    const card = await writeCard(makeCluster(), 3, [PICKED]);
    expect(card.publishedAt).toBe("2026-10-02T19:00:00Z");
    expect(card.severity).toBe(3);
  });

  it("does not reorder the caller's cluster", async () => {
    const cluster = makeCluster();
    const before = structuredClone(cluster);
    await writeCard(cluster, 3, [PICKED]);
    expect(cluster).toEqual(before);
  });

  it.each([
    ["no preference argument", undefined],
    ["an empty preference list", []],
    ["preferences none of which are in the cluster", [SOURCES[10] as Source]],
  ])("with %s, sends today's prompt and keeps today's order exactly", async (_label, preferred) => {
    await writeCard(makeCluster(), 3);
    const legacyContent = sentContent(0);
    const legacyCard = await writeCard(makeCluster(), 3);

    const card = await writeCard(makeCluster(), 3, preferred as Source[] | undefined);
    const content = sentContent(2);

    expect(content).toBe(legacyContent);
    expect(content).toBe(
      `Topic: ${TOPIC}\n\n${makeCluster()
        .articles.map((a) => `Source: ${a.source}\nTitle: ${a.title}\n${a.snippet}`)
        .join("\n\n")}`
    );
    expect(card.sources).toEqual(legacyCard.sources);
  });

  it("buildWriteCardContent matches what is sent", async () => {
    const cluster = makeCluster();
    await writeCard(cluster, 3);
    expect(sentContent()).toBe(buildWriteCardContent(cluster));
  });
});

describe("the full report inherits the order", () => {
  it("lists the persisted sources in Card.sources order, so preferred outlets lead there too", async () => {
    const card = await writeCard(makeCluster(), 3, [PICKED, PICKED_TOO]);
    mockParse.mockReset();
    mockParse.mockResolvedValue({ parsed_output: { report: "A full report." }, stop_reason: "end_turn" });

    await generateExpandedReport(card);

    expect(titleOrder(sentContent())).toEqual([1, 3, 0, 2]);
  });
});
