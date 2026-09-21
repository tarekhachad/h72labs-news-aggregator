import type { Cluster, Topic } from "@/types";
import type { RunShape } from "@/lib/usageRecord";

/**
 * How many stories one topic can contribute on the first run of a digest.
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
export const FIRST_RUN_CARDS_PER_TOPIC = 8;

/**
 * How many a later same-day run may add to a topic.
 *
 * A top-up updates a digest that already exists rather than composing a new
 * one, so it earns a smaller share: enough to carry genuine news that broke
 * since the first run, not another full edition. Without a smaller allowance
 * each run could add another 8 and the per-topic cap would stop meaning
 * anything by evening.
 */
export const TOP_UP_CARDS_PER_TOPIC = 2;

/**
 * The most any one topic may hold in a single digest, whatever sequence of
 * runs produced it.
 *
 * Per **digest**, not per day, and the distinction is real: the spend caps
 * permit 4 runs over a rolling 24 hours while a digest is one UTC date, so
 * runs at 22:00, 23:00, 00:10 and 01:00 are all allowed and produce two
 * digests of 10 cards per topic. Each is within this ceiling.
 *
 * At the shipped `max_digest_runs_per_window` of 4 the per-run allowances
 * above already cap a topic at 8 + 2 x 3 = 14, so this never binds. It is
 * kept because that run count is a `spend_config` column, editable in the
 * SQL editor with no deploy — at 8 runs the per-run allowances alone would
 * permit 22, and this is what stops a spend dial silently changing the
 * product.
 */
export const DAILY_CARDS_PER_TOPIC_CEILING = 14;

/** A cluster with the verdict triage gave it. */
export interface TriagedCluster {
  cluster: Cluster;
  severity: number;
}

/** What one topic lost to the cap, for logging. */
export interface TopicCut {
  topic: Topic;
  /** What this run was allowed for this topic: the per-run allowance, or less if the ceiling bound it. */
  allowance: number;
  dropped: number;
  total: number;
  /** Severities of the dropped clusters, highest first. */
  severities: number[];
}

export interface CardCapOptions {
  runShape: RunShape;
  /**
   * Today's already-persisted cards, or null when that lookup failed. Null
   * means "unknown", never "none" — an empty array is a genuinely empty
   * digest, and conflating the two would hand a top-up the first-run
   * allowance every time the lookup broke.
   */
  existingCards: readonly { topic: Topic }[] | null;
}

/**
 * How many cards this run may write for a topic, before the ceiling.
 *
 * `unknown` gets the top-up allowance. It arises when the existing-cards
 * lookup failed, so the run might be a top-up against a topic already at the
 * ceiling; granting the first-run allowance there would write up to 8 Sonnet
 * cards per topic that no clamp can take back. A thin first digest is
 * recoverable — the same outage generally also fails the save, so the retry
 * arrives as a clean `firstOfDay` — and unwarranted spend is not.
 *
 * Exhaustive with no `default`, so adding a run shape is a type error here
 * rather than a silent fall-through to whichever allowance happened to be
 * written last.
 */
export function perRunAllowanceFor(runShape: RunShape): number {
  switch (runShape) {
    case "firstEver":
    case "firstOfDay":
      return FIRST_RUN_CARDS_PER_TOPIC;
    case "sameDayTopUp":
    case "unknown":
      return TOP_UP_CARDS_PER_TOPIC;
  }
}

/**
 * The per-run allowance narrowed by whatever headroom the ceiling leaves.
 *
 * `existingForTopic` of null is the failed-lookup case: the ceiling cannot be
 * applied without knowing what is already there, so the per-run allowance
 * stands alone. Clamped at zero because a topic already past the ceiling
 * would otherwise produce a negative allowance and a nonsense slice.
 */
export function topicAllowance(perRunAllowance: number, existingForTopic: number | null): number {
  if (existingForTopic === null) return perRunAllowance;
  return Math.max(0, Math.min(perRunAllowance, DAILY_CARDS_PER_TOPIC_CEILING - existingForTopic));
}

/** Counted here rather than by the caller, so a wrong map cannot be handed in. */
function countByTopic(cards: readonly { topic: Topic }[]): Map<Topic, number> {
  const counts = new Map<Topic, number>();
  for (const card of cards) counts.set(card.topic, (counts.get(card.topic) ?? 0) + 1);
  return counts;
}

/**
 * Keeps at most this run's per-topic allowance of the highest-severity
 * clusters per topic, **preserving the input's ordering** — `kept` is a
 * subsequence of `notable`, not a severity-ranked list, so nothing
 * downstream sees a reordering it didn't ask for.
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
 * Ties at the allowance boundary are broken first by how many sources
 * corroborate the story, then by input order. Corroboration is the same
 * signal `modelForCluster` in writeCard.ts already acts on when it routes a
 * multi-source cluster to Sonnet: one source is one account of events, and
 * several independent outlets carrying a story is evidence about the story
 * rather than about the outlets. Input order remains the final tie-break —
 * arbitrary but deterministic, where the alternative is a coin flip between
 * two stories triage graded identically and equally corroborated.
 *
 * Selection is tracked by **index, not object identity**. Identity would be
 * the obvious choice and is wrong: a `Set` keyed on the item objects can't
 * distinguish two array slots holding the same reference, so one duplicated
 * reference lets a topic exceed its own cap. Nothing in today's pipeline
 * produces that input, but a cap that can be talked out of capping is not
 * worth the risk of finding out.
 */
export function applyCardCap<T extends TriagedCluster>(
  notable: T[],
  options: CardCapOptions
): { kept: T[]; cuts: TopicCut[] } {
  const perRunAllowance = perRunAllowanceFor(options.runShape);
  const existingByTopic = options.existingCards === null ? null : countByTopic(options.existingCards);

  const indicesByTopic = new Map<Topic, number[]>();
  notable.forEach((item, i) => {
    const group = indicesByTopic.get(item.cluster.topic);
    if (group === undefined) indicesByTopic.set(item.cluster.topic, [i]);
    else group.push(i);
  });

  const keptIndices = new Set<number>();
  const cuts: TopicCut[] = [];

  for (const [topic, indices] of indicesByTopic) {
    // The explicit null test matters and is not the same as `?.get(topic) ?? 0`:
    // a failed lookup must skip the ceiling, not apply it against zero. The two
    // are indistinguishable while the ceiling exceeds every allowance, which is
    // why no test here can tell them apart — the test that keeps the ceiling
    // above every allowance is what makes that safe, and if it ever fails this
    // line is the reason to come back and read.
    const allowance = topicAllowance(
      perRunAllowance,
      existingByTopic === null ? null : (existingByTopic.get(topic) ?? 0)
    );

    if (indices.length <= allowance) {
      for (const i of indices) keptIndices.add(i);
      continue;
    }
    // Sorted on a copy so the map's own arrays stay in input order. Indices
    // start ascending and Array#sort is stable, so clusters equal on both
    // severity and corroboration keep their original relative order — that's
    // the final tie-break above.
    const ranked = [...indices].sort(
      (a, b) =>
        notable[b].severity - notable[a].severity ||
        notable[b].cluster.articles.length - notable[a].cluster.articles.length
    );
    for (const i of ranked.slice(0, allowance)) keptIndices.add(i);

    const dropped = ranked.slice(allowance);
    cuts.push({
      topic,
      allowance,
      dropped: dropped.length,
      total: indices.length,
      severities: dropped.map((i) => notable[i].severity),
    });
  }

  return { kept: notable.filter((_, i) => keptIndices.has(i)), cuts };
}
