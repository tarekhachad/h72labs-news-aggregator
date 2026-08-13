import type { Cluster, Topic } from "@/types";

/**
 * How many stories one topic can contribute to a single digest.
 *
 * Triage judges each cluster against its own topic's typical-day baseline,
 * which answers "is this worth knowing?" but never "how much is too much?"
 * — and nothing downstream bounded the total. The Final Phase's measured
 * run produced 130 cards across 9 topics: a scan of the day, not the
 * "handful of genuinely worthwhile items per topic" the triage prompt
 * itself describes, with Sonnet paid to write the tail of it.
 *
 * 8 leaves room for a genuinely busy day in one topic while keeping a
 * full-profile digest readable in one sitting.
 */
export const MAX_CARDS_PER_TOPIC = 8;

/** A cluster with the verdict triage gave it. */
export interface TriagedCluster {
  cluster: Cluster;
  severity: number;
}

/** What one topic lost to the cap, for logging. */
export interface TopicCut {
  topic: Topic;
  dropped: number;
  total: number;
  /** Severities of the dropped clusters, highest first. */
  severities: number[];
}

/**
 * Keeps at most `MAX_CARDS_PER_TOPIC` of the highest-severity clusters per
 * topic, **preserving the input's ordering** — `kept` is a subsequence of
 * `notable`, not a severity-ranked list, so nothing downstream sees a
 * reordering it didn't ask for.
 *
 * Returns the cuts alongside the kept set rather than offering a second
 * function to recompute them. Two functions deriving "what was dropped"
 * independently is two things to keep in agreement, and the whole point of
 * logging the cut is that it's an accurate account of work thrown away.
 *
 * Deliberately does NOT backfill a thin topic from rejected clusters.
 * Triage's own prompt says: "If a topic genuinely has nothing worth
 * including today, that's a true and useful signal to surface, not a
 * failure to correct — don't stretch to fill a quota." Promoting a reject
 * here would override that judgment *and* pay to write a story triage
 * already decided wasn't worth reading.
 *
 * What's cut is cut permanently: `saveGeneratedCards` advances the digest's
 * since-cursor regardless, so those articles fall before the next run's
 * cutoff and are never reconsidered. Accepted deliberately — they're the
 * least significant stories within their own topic — but it's why the cut
 * is logged rather than dropped silently.
 *
 * Ties at the cap boundary are broken by input order, so the earlier-listed
 * cluster wins. Arbitrary but deterministic: the alternative is a coin flip
 * between two stories triage graded identically.
 *
 * Selection is tracked by **index, not object identity**. Identity would be
 * the obvious choice and is wrong: a `Set` keyed on the item objects can't
 * distinguish two array slots holding the same reference, so one duplicated
 * reference lets a topic exceed its own cap. Nothing in today's pipeline
 * produces that input, but a cap that can be talked out of capping is not
 * worth the risk of finding out.
 */
export function applyCardCap<T extends TriagedCluster>(
  notable: T[]
): { kept: T[]; cuts: TopicCut[] } {
  const indicesByTopic = new Map<Topic, number[]>();
  notable.forEach((item, i) => {
    const group = indicesByTopic.get(item.cluster.topic);
    if (group === undefined) indicesByTopic.set(item.cluster.topic, [i]);
    else group.push(i);
  });

  const keptIndices = new Set<number>();
  const cuts: TopicCut[] = [];

  for (const [topic, indices] of indicesByTopic) {
    if (indices.length <= MAX_CARDS_PER_TOPIC) {
      for (const i of indices) keptIndices.add(i);
      continue;
    }
    // Sorted on a copy so the map's own arrays stay in input order. Indices
    // start ascending and Array#sort is stable, so equal severities keep
    // their original relative order — that's the tie-break above.
    const ranked = [...indices].sort((a, b) => notable[b].severity - notable[a].severity);
    for (const i of ranked.slice(0, MAX_CARDS_PER_TOPIC)) keptIndices.add(i);

    const dropped = ranked.slice(MAX_CARDS_PER_TOPIC);
    cuts.push({
      topic,
      dropped: dropped.length,
      total: indices.length,
      severities: dropped.map((i) => notable[i].severity),
    });
  }

  return { kept: notable.filter((_, i) => keptIndices.has(i)), cuts };
}
