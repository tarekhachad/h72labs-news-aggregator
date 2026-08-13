import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Cluster, Article, Topic } from "@/types";

// --- Mock the embedding layer -------------------------------------------
// We keep the REAL cosineSimilarity (pure dot product, deterministic and
// cheap) but replace embed() with a deterministic lookup so we can control
// exactly which texts are "similar" to which, without loading the real
// transformer model (slow, and would try to download weights offline).
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => texts.map(vectorForText)),
  };
});

// 2D unit vectors on the unit circle so dot-product == cosine similarity is
// easy to reason about: cos(0) = 1, cos(90deg) = 0, etc.
const V = {
  existingAI: [1, 0],
  // ~25.8 degrees off existingAI -> cosine ~0.9 (clearly above both the
  // 0.5 dup-candidate gate and would even clear cluster.ts's 0.65 merge
  // threshold) -> "very similar."
  sameStoryAI: [0.9, Math.sqrt(1 - 0.9 * 0.9)],
  // ~53.1 degrees off existingAI -> cosine 0.6 -> above the 0.5 gate but
  // below cluster.ts's 0.65 merge threshold -> "similar enough to ask
  // Haiku, not similar enough to auto-decide."
  similarButDifferentAI: [0.6, 0.8],
  // Orthogonal -> cosine 0 -> clearly below the 0.5 gate.
  dissimilarAI: [0, 1],
  existingPolitics: [0, 1], // orthogonal to existingAI on purpose
};

function vectorForText(text: string): number[] {
  if (text.includes("SAME_STORY_MARKER")) return V.sameStoryAI;
  if (text.includes("SIMILAR_BUT_DIFFERENT_MARKER")) return V.similarButDifferentAI;
  if (text.includes("DISSIMILAR_MARKER")) return V.dissimilarAI;
  if (text.includes("EXISTING_AI_SUMMARY")) return V.existingAI;
  if (text.includes("EXISTING_POLITICS_SUMMARY")) return V.existingPolitics;
  if (text.includes("CROSS_TOPIC_MARKER")) return V.existingAI; // deliberately identical to existingAI
  throw new Error(`vectorForText: no mapping for text: ${text}`);
}

// --- Mock the Anthropic SDK ----------------------------------------------
// isSameStory is the only thing that talks to Anthropic. We control its
// response via a shared mock `parse` fn so each test can decide what Haiku
// "says," and can throw to exercise the fail-open path.
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  // Must be usable as `new Anthropic()` (dedup.ts constructs it at module
  // load time) — an arrow function can't be a constructor, so this uses a
  // plain function whose returned object overrides the `this` binding.
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

// zodOutputFormat just builds a plain config object from a schema — no
// network call, no reason to mock it.

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    title: "A title",
    snippet: "A snippet",
    url: "https://example.com/a",
    source: "BBC",
    topic: "Tech/AI",
    publishedAt: "2026-07-31T12:00:00Z",
    ...overrides,
  };
}

function makeCluster(topic: Topic, marker: string): Cluster {
  return {
    topic,
    articles: [makeArticle({ topic, title: marker, snippet: "details" })],
  };
}

beforeEach(() => {
  mockParse.mockReset();
});

describe("isSameStory", () => {
  it("returns true when Haiku confirms the same story", async () => {
    mockParse.mockResolvedValue({ parsed_output: { sameStory: true } });
    const { isSameStory } = await import("@/lib/dedup");
    await expect(isSameStory("candidate text", "existing summary")).resolves.toBe(true);
  });

  it("returns false when Haiku says it's a different story", async () => {
    mockParse.mockResolvedValue({ parsed_output: { sameStory: false } });
    const { isSameStory } = await import("@/lib/dedup");
    await expect(isSameStory("candidate text", "existing summary")).resolves.toBe(false);
  });

  it("fails open (returns false, does not throw) when the Anthropic call throws", async () => {
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { isSameStory } = await import("@/lib/dedup");
    await expect(isSameStory("candidate text", "existing summary")).resolves.toBe(false);
  });
});

describe("filterAlreadyCovered", () => {
  it("returns all clusters unchanged when there are no existing cards", async () => {
    const { filterAlreadyCovered } = await import("@/lib/dedup");
    const clusters = [makeCluster("Tech/AI", "SAME_STORY_MARKER")];
    const result = await filterAlreadyCovered(clusters, []);
    expect(result).toEqual(clusters);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("excludes a cluster that is embedding-similar AND confirmed same-story by Haiku", async () => {
    mockParse.mockResolvedValue({ parsed_output: { sameStory: true } });
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    const cluster = makeCluster("Tech/AI", "SAME_STORY_MARKER");
    const result = await filterAlreadyCovered(
      [cluster],
      [{ topic: "Tech/AI", shortSummary: "EXISTING_AI_SUMMARY" }]
    );

    expect(result).toEqual([]);
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it("keeps a cluster that is embedding-dissimilar, and never calls Haiku for it", async () => {
    // If the threshold gate were broken, this would blow up the test since
    // mockParse isn't configured with a resolved value at all here.
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    const cluster = makeCluster("Tech/AI", "DISSIMILAR_MARKER");
    const result = await filterAlreadyCovered(
      [cluster],
      [{ topic: "Tech/AI", shortSummary: "EXISTING_AI_SUMMARY" }]
    );

    expect(result).toEqual([cluster]);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("keeps a cluster that clears the similarity gate but Haiku says is a different story", async () => {
    mockParse.mockResolvedValue({ parsed_output: { sameStory: false } });
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    const cluster = makeCluster("Tech/AI", "SIMILAR_BUT_DIFFERENT_MARKER");
    const result = await filterAlreadyCovered(
      [cluster],
      [{ topic: "Tech/AI", shortSummary: "EXISTING_AI_SUMMARY" }]
    );

    expect(result).toEqual([cluster]);
    // It DID clear the embedding gate (0.6 > 0.5), so Haiku should have
    // been consulted, unlike the dissimilar case above.
    expect(mockParse).toHaveBeenCalledTimes(1);
  });

  it("never compares a cluster against an existing card in a different topic, even if their text would embed as very similar", async () => {
    // sameStory=true so if topic scoping were broken and this cluster got
    // compared against the Tech/AI card (whose vector is identical, by
    // construction, to this cluster's vector), it would incorrectly be
    // excluded. It must survive because it's in a different topic than
    // the only existing card that would match it.
    mockParse.mockResolvedValue({ parsed_output: { sameStory: true } });
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    const crossTopicCluster: Cluster = {
      topic: "US Politics",
      articles: [makeArticle({ topic: "US Politics", title: "CROSS_TOPIC_MARKER", snippet: "" })],
    };

    const result = await filterAlreadyCovered(
      [crossTopicCluster],
      [
        { topic: "Tech/AI", shortSummary: "EXISTING_AI_SUMMARY" },
        { topic: "US Politics", shortSummary: "EXISTING_POLITICS_SUMMARY" }, // orthogonal vector -> dissimilar
      ]
    );

    expect(result).toEqual([crossTopicCluster]);
    // The only same-topic existing card (US Politics) is dissimilar
    // (orthogonal vector), so Haiku should never be consulted at all.
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("handles a mixed batch: excludes duplicates, keeps dissimilar and confirmed-different clusters, all within one call", async () => {
    mockParse.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      const content = messages[0].content;
      const sameStory = content.includes("SAME_STORY_MARKER");
      return { parsed_output: { sameStory } };
    });
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    const duplicate = makeCluster("Tech/AI", "SAME_STORY_MARKER");
    const dissimilar = makeCluster("Tech/AI", "DISSIMILAR_MARKER");
    const similarButDifferent = makeCluster("Tech/AI", "SIMILAR_BUT_DIFFERENT_MARKER");

    const result = await filterAlreadyCovered(
      [duplicate, dissimilar, similarButDifferent],
      [{ topic: "Tech/AI", shortSummary: "EXISTING_AI_SUMMARY" }]
    );

    expect(result).toEqual([dissimilar, similarButDifferent]);
    // Only the two clusters that cleared the embedding gate (duplicate,
    // similarButDifferent) should have triggered a Haiku call.
    expect(mockParse).toHaveBeenCalledTimes(2);
  });

  it("F.4.5 CANARY: issues one unbatched Haiku call per candidate even past triage's 20-cluster batch cap, within a single topic", async () => {
    // F.4.5 batched triage.ts's per-cluster fan-out into ≤20-cluster groups
    // (planTriageBatches / MAX_CLUSTERS_PER_BATCH), but deliberately left
    // dedup.ts's isSameStory fan-out untouched -- this is the exact claim
    // the F.4.5 review round's rewritten comments make (dedup.ts's
    // filterAlreadyCovered comment, usageCollector.ts's ambient-collector
    // comment, and ROADMAP.md's new deferred entry all assert it). Prove it
    // numerically: 25 same-topic candidates, all clearing the embedding
    // gate, must produce exactly 25 separate Haiku calls -- not the ~2
    // batched calls triage's MAX_CLUSTERS_PER_BATCH=20 would produce for
    // the same input shape, and not 1 combined call either.
    mockParse.mockResolvedValue({ parsed_output: { sameStory: false } });
    const { filterAlreadyCovered } = await import("@/lib/dedup");

    const candidates = Array.from({ length: 25 }, (_, i) =>
      makeCluster("Tech/AI", `SAME_STORY_MARKER-${i}`)
    );

    const result = await filterAlreadyCovered(candidates, [
      { topic: "Tech/AI", shortSummary: "EXISTING_AI_SUMMARY" },
    ]);

    expect(result).toEqual(candidates);
    expect(mockParse).toHaveBeenCalledTimes(25);
    // Each call carries exactly one candidate's text, not several batched
    // into one prompt the way triage.ts's judgeBatch numbers a list.
    for (const call of mockParse.mock.calls) {
      const content = (call[0] as { messages: { content: string }[] }).messages[0].content;
      const markerHits = content.match(/SAME_STORY_MARKER-\d+/g) ?? [];
      expect(new Set(markerHits).size).toBe(1);
    }
  });
});
