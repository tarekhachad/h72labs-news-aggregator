import type { Cluster } from "@/types";
import type { TrackedModel } from "@/lib/usage";

/**
 * Single-source clusters are written by Haiku, multi-source ones by Sonnet.
 *
 * This step's whole claim on a capable model is the prompt's own
 * instruction — "Synthesize across sources; don't just paraphrase one" —
 * and the Final Phase measured that ~89% of clusters are a single article,
 * where there is nothing to synthesize and the task is ordinary short-form
 * summarization of text already in the prompt. Sonnet is kept for exactly
 * the clusters the product claim is about.
 *
 * Judged on article count rather than anything subtler because that IS the
 * distinction: one source means one account of events.
 */
export function modelForCluster(cluster: Cluster): TrackedModel {
  return cluster.articles.length === 1 ? "claude-haiku-4-5" : "claude-sonnet-5";
}
