import type { Cluster } from "@/types";
import type { TrackedModel } from "@/lib/usage";
import { MODELS } from "@/lib/models";

/**
 * Single-source and multi-source clusters are written from separate entries
 * in `MODELS`, so either can move to another model on its own.
 *
 * This step's whole claim on a capable model is the prompt's own
 * instruction — "Synthesize across sources; don't just paraphrase one" —
 * and the Final Phase measured that ~89% of clusters are a single article,
 * where there is nothing to synthesize and the task is ordinary short-form
 * summarization of text already in the prompt. The multi-source entry is
 * the one to raise if synthesis quality drops.
 *
 * Judged on article count rather than anything subtler because that IS the
 * distinction: one source means one account of events.
 */
export function modelForCluster(cluster: Cluster): TrackedModel {
  return cluster.articles.length === 1 ? MODELS.writeCardSingle : MODELS.writeCardMulti;
}
