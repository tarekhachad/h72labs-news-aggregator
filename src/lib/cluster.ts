import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import type { Article, Cluster } from "@/types";

// Empirically tuned against real RSS pulls: at 0.78, genuine same-story
// cross-source pairs (e.g. NYT/BBC both covering the France/Spain
// wildfires) scored as low as 0.70-0.777 — just under the old threshold —
// so cross-source stories almost never merged. 0.65 catches those while
// sitting above the one observed false-positive (0.634, a generic NYT
// live-blog title "Here's the latest." coincidentally matching an
// unrelated story). Revisit if real digests start over-merging.
const SIMILARITY_THRESHOLD = 0.65;

// Loading the model is slow (first call downloads + initializes it), so it's
// cached across calls within the same server instance instead of reloaded
// per request.
let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;
function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    embedderPromise = pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }
  return embedderPromise;
}

// A transformer model pads every sequence in a batch to match the longest
// one in that same batch, and attention memory scales with roughly
// batch_size × longest_sequence². Embedding a large digest's worth of
// articles (a full topic/source selection can pull 1000+) in one single
// batch combined with even one unusually long article's text is enough to
// blow memory up catastrophically — this crashed a real machine. Chunking
// into bounded batches caps peak memory to one chunk's worth, regardless
// of how many articles a digest ends up pulling in total.
const EMBED_BATCH_SIZE = 64;

async function embed(texts: string[]): Promise<number[][]> {
  const embedder = await getEmbedder();
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const output = await embedder(batch, { pooling: "mean", normalize: true });
    const [rows, cols] = output.dims;
    const data = output.data as Float32Array;
    for (let r = 0; r < rows; r++) {
      vectors.push(Array.from(data.slice(r * cols, (r + 1) * cols)));
    }
  }

  return vectors;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already normalized, so dot product == cosine similarity
}

/**
 * Greedy clustering: walk articles in order, attach each one to the first
 * existing cluster whose centroid it's similar enough to, otherwise start
 * a new cluster. Simple, and fine for how this is actually used — a
 * user's topic/source selection can realistically pull anywhere from
 * dozens to (at a large selection) 1000+ articles; revisit if this
 * O(articles × clusters) scan becomes the bottleneck rather than
 * embedding memory.
 */
export async function clusterArticles(articles: Article[]): Promise<Cluster[]> {
  if (articles.length === 0) return [];

  const vectors = await embed(
    articles.map((a) => `${a.title}. ${a.snippet}`)
  );

  const clusters: { articles: Article[]; centroid: number[] }[] = [];

  articles.forEach((article, i) => {
    const vector = vectors[i];
    const match = clusters.find(
      (c) => cosineSimilarity(c.centroid, vector) >= SIMILARITY_THRESHOLD
    );

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
