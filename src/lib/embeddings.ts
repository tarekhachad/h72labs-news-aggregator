import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

// Loading the model is slow (first call downloads + initializes it), so it's
// cached across calls within the same server instance instead of reloaded
// per request. Shared by cluster.ts and dedup.ts so both use one loaded
// instance instead of two.
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
// text (a full topic/source selection can pull 1000+ articles) in one single
// batch combined with even one unusually long item is enough to blow memory
// up catastrophically — this crashed a real machine. Chunking into bounded
// batches caps peak memory to one chunk's worth, regardless of how much text
// a caller ends up embedding in total.
const EMBED_BATCH_SIZE = 64;

export async function embed(texts: string[]): Promise<number[][]> {
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

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already normalized, so dot product == cosine similarity
}
