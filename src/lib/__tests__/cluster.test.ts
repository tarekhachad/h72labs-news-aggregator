import { describe, it, expect, vi } from "vitest";
import type { Article } from "@/types";

// Deterministic embed() so clustering behavior is controlled purely by the
// vectors we hand back, not by the real (slow, model-dependent) embedder.
// cosineSimilarity is left real (pure dot product).
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) => texts.map(vectorForText)),
  };
});

// Angle-based unit vectors so we can hit similarity values right around the
// module's SIMILARITY_THRESHOLD (0.65) precisely (cos/sin of an angle from
// [1, 0] gives dot-product == that cosine, since both are unit length).
function unitVectorAtCosine(cosine: number): number[] {
  return [cosine, Math.sqrt(1 - cosine * cosine)];
}

const V = {
  base: [1, 0],
  // cosine(base, aboveThreshold) = 0.9 -> clears 0.65 -> should merge.
  aboveThreshold: unitVectorAtCosine(0.9),
  // cosine(base, belowThreshold) = 0.6 -> below 0.65 -> should NOT merge.
  belowThreshold: unitVectorAtCosine(0.6),

  // Best-match-not-first-match setup: seedA = [1, 0], seedB = [0, 1] (cosine
  // 0 between them -> they stay separate clusters). A probe vector at 48
  // degrees from seedA clears the 0.65 threshold against BOTH seeds
  // (cos(48deg) = 0.669 to A, sin(48deg) = 0.743 to B), but is closer to B.
  // A first-match implementation (take whichever cluster is encountered
  // first in iteration order that merely clears the threshold, without
  // comparing to find the best one) would incorrectly attach the probe to
  // A, since A was inserted first and A is scanned before B.
  seedA: [1, 0],
  seedB: [0, 1],
  probe: unitVectorAtCosine(Math.cos((48 * Math.PI) / 180)),
};

function vectorForText(text: string): number[] {
  if (text.includes("BASE_MARKER")) return V.base;
  if (text.includes("ABOVE_THRESHOLD_MARKER")) return V.aboveThreshold;
  if (text.includes("BELOW_THRESHOLD_MARKER")) return V.belowThreshold;
  if (text.includes("SEED_A_MARKER")) return V.seedA;
  if (text.includes("SEED_B_MARKER")) return V.seedB;
  if (text.includes("PROBE_MARKER")) return V.probe;
  throw new Error(`vectorForText: no mapping for text: ${text}`);
}

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    title: "title",
    snippet: "snippet",
    url: "https://example.com",
    source: "BBC",
    topic: "Tech/AI",
    publishedAt: "2026-07-31T12:00:00Z",
    ...overrides,
  };
}

describe("clusterArticles (post-extraction sanity check)", () => {
  it("returns an empty array for no articles, without calling embed", async () => {
    const { clusterArticles } = await import("@/lib/cluster");
    const { embed } = await import("@/lib/embeddings");
    const result = await clusterArticles([]);
    expect(result).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it("merges two articles whose similarity clears SIMILARITY_THRESHOLD (0.65) into one cluster", async () => {
    const { clusterArticles } = await import("@/lib/cluster");
    const a = makeArticle({ title: "BASE_MARKER" });
    const b = makeArticle({ title: "ABOVE_THRESHOLD_MARKER" });

    const clusters = await clusterArticles([a, b]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].articles).toHaveLength(2);
  });

  it("keeps two articles whose similarity is below SIMILARITY_THRESHOLD (0.65) as separate clusters", async () => {
    const { clusterArticles } = await import("@/lib/cluster");
    const a = makeArticle({ title: "BASE_MARKER" });
    const b = makeArticle({ title: "BELOW_THRESHOLD_MARKER" });

    const clusters = await clusterArticles([a, b]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0].articles).toHaveLength(1);
    expect(clusters[1].articles).toHaveLength(1);
  });

  it("attaches a new article to the best-matching existing cluster, not just the first one that clears the threshold", async () => {
    const { clusterArticles } = await import("@/lib/cluster");
    const seedA = makeArticle({ title: "SEED_A_MARKER" });
    const seedB = makeArticle({ title: "SEED_B_MARKER" });
    const probe = makeArticle({ title: "PROBE_MARKER" });

    // Insertion order matters for this test: seedA first, seedB second
    // (forms its own cluster since dissimilar to A), then probe — which
    // clears threshold against both existing clusters but is closer to B.
    const clusters = await clusterArticles([seedA, seedB, probe]);

    expect(clusters).toHaveLength(2);
    const probeCluster = clusters.find((c) =>
      c.articles.some((a) => a.title === "PROBE_MARKER")
    );
    expect(probeCluster).toBeDefined();
    expect(probeCluster!.articles.map((a) => a.title).sort()).toEqual(
      ["PROBE_MARKER", "SEED_B_MARKER"].sort()
    );
  });

  it("tags each output cluster with the topic of its first article", async () => {
    const { clusterArticles } = await import("@/lib/cluster");
    const a = makeArticle({ title: "BASE_MARKER", topic: "US Finance" });
    const clusters = await clusterArticles([a]);
    expect(clusters[0].topic).toBe("US Finance");
  });
});
