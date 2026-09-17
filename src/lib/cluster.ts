import type { Article, Cluster } from "@/types";
import { embed, cosineSimilarity } from "@/lib/embeddings";

// Empirically tuned against real RSS pulls: at 0.78, genuine same-story
// cross-source pairs (e.g. NYT/BBC both covering the France/Spain
// wildfires) scored as low as 0.70-0.777 — just under the old threshold —
// so cross-source stories almost never merged. 0.65 catches those while
// sitting above the one observed false-positive (0.634, a generic NYT
// live-blog title "Here's the latest." coincidentally matching an
// unrelated story). Revisit if real digests start over-merging.
const SIMILARITY_THRESHOLD = 0.65;

// Every other consumer of an article's snippet already bounds it — dedup at
// SNIPPET_CHARS_PER_ARTICLE, triage at 200 — because a snippet is whatever a
// feed put in it, with no ceiling. Clustering embedded the whole thing, and
// that is what killed a production run: one feed item of 48,191 characters in
// a batch of 64 took the instance from 180 MB past its 2048 MB limit in five
// seconds, because a transformer pads every text in a batch to the longest
// one and attention memory grows with the SQUARE of that length.
//
// 1000 is generous rather than tight: across real pulls the median article
// text is ~200 characters and the 95th percentile ~735, so this changes
// nothing for almost every article and clips only the outliers that cost
// quadratically. The model itself reads about 500 tokens, so text past this
// point barely moves the vector anyway — measured against the real model,
// clipping here never moved a same-story pair below the threshold below, nor
// a different-story pair above it.
//
// Only the snippet is clipped, because only the snippet is unbounded in
// practice. A pathologically long TITLE is caught by embed()'s own backstop,
// which is what that second layer is for.
const SNIPPET_CHARS_FOR_CLUSTERING = 1000;

/**
 * Greedy clustering: walk articles in order, attach each one to the
 * best-matching existing cluster whose centroid it's similar enough to
 * (highest cosine similarity among all clusters clearing the threshold,
 * not just the first one found), otherwise start a new cluster. Simple,
 * and fine for how this is actually used — a user's topic/source
 * selection can realistically pull anywhere from dozens to (at a large
 * selection) 1000+ articles; revisit if this O(articles × clusters) scan
 * becomes the bottleneck rather than embedding memory.
 */
export async function clusterArticles(articles: Article[]): Promise<Cluster[]> {
  if (articles.length === 0) return [];

  const vectors = await embed(
    articles.map((a) => `${a.title}. ${a.snippet.slice(0, SNIPPET_CHARS_FOR_CLUSTERING)}`)
  );

  const clusters: { articles: Article[]; centroid: number[] }[] = [];

  articles.forEach((article, i) => {
    const vector = vectors[i];
    // Best-match, not first-match: an article near the threshold can clear
    // it against more than one existing cluster (centroids drift as
    // clusters grow), and always taking whichever comes first in insertion
    // order — rather than the one it's actually closest to — was a source
    // of order-dependent inconsistency in how same-story articles grouped.
    let match: { articles: Article[]; centroid: number[] } | null = null;
    let bestSimilarity = -Infinity;
    for (const c of clusters) {
      const similarity = cosineSimilarity(c.centroid, vector);
      if (similarity >= SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        match = c;
        bestSimilarity = similarity;
      }
    }

    if (match) {
      match.articles.push(article);
      // Re-average the centroid so it reflects the whole cluster so far.
      const n = match.articles.length;
      match.centroid = match.centroid.map(
        (v, idx) => (v * (n - 1) + vector[idx]) / n
      );
    } else {
      clusters.push({ articles: [article], centroid: vector });
    }
  });

  return clusters.map((c) => ({
    topic: c.articles[0].topic,
    articles: c.articles,
  }));
}
