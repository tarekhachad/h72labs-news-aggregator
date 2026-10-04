// Holds a module-scope Anthropic client, so this file must never reach a
// browser bundle.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Article, Cluster } from "@/types";
import type { ReadingUnit } from "@/lib/readingUnits";
import { cosineSimilarity, embed } from "@/lib/embeddings";
import { normalizeArticleUrl } from "@/lib/ingest";
import { boundOf, recordCall } from "@/lib/usageCollector";
import { bestEffortLog } from "@/lib/bestEffortLog";

/**
 * The duplicate check: one real-world event should produce one card.
 *
 * Clustering groups articles by embedding their headlines and snippets, and it
 * misses three kinds of duplicate: differently worded coverage, a French
 * article and English coverage of the same event (the model is English-only),
 * and one outlet's two articles on one event. Triage now gives every notable
 * cluster one English sentence on what happened, which puts every story in one
 * language and one shape, and this module compares those sentences across the
 * whole run, across topics and countries alike.
 *
 * **The embedding score never merges anything on its own.** It only chooses
 * which pairs are worth asking about; one batched Haiku call decides each one.
 * Measured with the real model on English event sentences, different events
 * written in the same pattern score as high as true duplicates: "Real Madrid
 * beat Barcelona 2-1" vs "Real Madrid beat Sevilla 2-1" scores 0.935, Russian
 * strikes on Kyiv vs on Lviv 0.826, Israeli strikes in Gaza vs in Lebanon
 * 0.782, while one French no-confidence vote worded two ways scores 0.599. No
 * line separates them, and a wrong merge hides a story from the reader while a
 * missed one only shows a near-repeat.
 *
 * Related angles on one situation stay separate (two takes on Brazil's
 * election, two takes on a bond sell-off): only the same event merges.
 */

const MODEL = "claude-haiku-4-5";

/**
 * The lowest sentence similarity worth asking Haiku about.
 *
 * From the fixtures in __tests__/fixtures/duplicateEvents.ts, scored with the
 * real model: the lowest same-event pair is 0.599 (one no-confidence vote,
 * worded two ways) and the must-merge groups score 0.656 to 0.843; the highest
 * pair of unrelated stories from the same day is 0.503 (two different strikes
 * in the Russia-Ukraine war). 0.55 sits between them. Lower only adds pairs
 * Haiku will reject; higher starts losing real duplicates before Haiku sees
 * them. Of the two keep-separate pairs, the bond angles (0.565) reach Haiku,
 * which is what the prompt's rule is for; the Brazil angles (0.427) do not.
 */
export const CANDIDATE_THRESHOLD = 0.55;

/**
 * The most pairs one run sends to Haiku. Pairs are sent highest score first,
 * so the cap drops the least likely duplicates, and a dropped pair just stays
 * two cards.
 *
 * 30 because the stage must fit in about 5 s on the digest's critical path:
 * each verdict is ~10 output tokens, so 30 pairs is ~350 tokens, about 2-3 s
 * of Haiku output on top of its first-token latency. A day with about 1 card
 * in 8 duplicated, at the 10-unit worst case of ~80 cards, has about 10 real
 * duplicate pairs, so 30 leaves room for the same-pattern pairs (a team's
 * several results, a war's several strikes) that score alongside them.
 */
export const MAX_PAIRS_PER_RUN = 30;

/**
 * The call's own limit. With no SDK retries (below), this bounds the stage's
 * Haiku time; the local embedding of ~80 sentences adds well under a second.
 * A call past it merges nothing, which is the safe direction.
 */
export const MERGE_TIMEOUT_MS = 4_000;

/** ~350 tokens at the pair cap; the ceiling costs nothing unless reached. */
const MAX_TOKENS = 1024;

/** A sentence is asked for at ~25 words; anything far past that is clipped. */
const EVENT_CHARS = 300;
const HEADLINE_CHARS = 150;

// Its own client rather than triage's: no retries and a short timeout, so a
// slow or failing call costs the run at most MERGE_TIMEOUT_MS. Retrying would
// buy a merge at the price of the whole digest's time budget.
const client = new Anthropic({ maxRetries: 0, timeout: MERGE_TIMEOUT_MS });

const SYSTEM_PROMPT = `You check a personalized daily news brief for duplicate stories before it is written. Each numbered pair below holds two stories, A and B. Each story is given as a one-sentence summary of what happened, plus one of its headlines (a headline may be in another language). For each pair, decide whether A and B report the same real-world event.

Same event (same: true): the same specific occurrence, reported by different outlets or in different words — the same match, the same attack, the same vote, the same announcement, the same strike or protest.

Not the same event (same: false):
- Related angles on one situation: analysis, reaction, background, or a different aspect of the same ongoing story. Polls showing an election is deadlocked and a piece on what that election means for another country are two stories, not one.
- A follow-up or a later development of an earlier event.
- Two separate events of the same kind, even when they are worded alike: two different matches by the same team, attacks on two different cities, two central banks' rate decisions, two earthquakes. Different places, opponents, dates, scores, numbers or people usually mean different events.

When in doubt, answer false. Merging two different stories hides one of them from the reader; leaving a duplicate only shows a near-repeat.

Return exactly one verdict per pair, carrying the number it was given.`;

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      pair: z.number().int(),
      same: z.boolean(),
    }),
  ),
});

/**
 * What the route hands in: a judged cluster the card cap kept and, when
 * notable, its sentence. `severity` may carry the preferred-source boost, in
 * which case `triageSeverity` holds triage's own grade (see
 * boostPreferredClusters).
 */
export interface MergeCandidate {
  cluster: Cluster;
  notable: boolean;
  severity: number;
  triageSeverity?: number;
  event?: string;
}

export interface MergeResult<T> {
  /** The judged clusters with every absorbed one removed, in input order. */
  items: T[];
  /** Clusters absorbed into another one this run. */
  merged: number;
  /** Whether the Haiku call was made: 0 or 1, for the run's expected-call count. */
  haikuCalls: 0 | 1;
}

export interface CandidatePair {
  /** Indices into the items array, a < b. */
  a: number;
  b: number;
  score: number;
}

/** Whitespace collapsed, clipped by code point so no surrogate pair is split. */
function flatten(value: string, maxPoints: number): string {
  const points = Array.from(value.replace(/\s+/g, " ").trim());
  return points.length > maxPoints ? `${points.slice(0, maxPoints).join("")}…` : points.join("");
}

function usableEvent(item: MergeCandidate): string | null {
  if (item.notable !== true || typeof item.event !== "string") return null;
  const event = flatten(item.event, EVENT_CHARS);
  return event === "" ? null : event;
}

function subtopicOf(cluster: Cluster): string | null {
  return typeof cluster.subtopic === "string" && cluster.subtopic !== "" ? cluster.subtopic : null;
}

function unitLabel(cluster: Cluster): string {
  const subtopic = subtopicOf(cluster);
  return subtopic === null ? cluster.topic : `${cluster.topic}: ${subtopic}`;
}

/**
 * Every pair of sentences scoring at or above CANDIDATE_THRESHOLD, highest
 * first (ties by position, so the order is deterministic), capped at
 * MAX_PAIRS_PER_RUN. `dropped` is how many cleared the threshold past the cap.
 */
export function candidatePairs(
  indices: readonly number[],
  vectors: readonly number[][],
): { pairs: CandidatePair[]; dropped: number } {
  const all: CandidatePair[] = [];
  for (let i = 0; i < indices.length; i += 1) {
    for (let j = i + 1; j < indices.length; j += 1) {
      const score = cosineSimilarity(vectors[i], vectors[j]);
      if (Number.isFinite(score) && score >= CANDIDATE_THRESHOLD) {
        all.push({ a: indices[i], b: indices[j], score });
      }
    }
  }
  all.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  return { pairs: all.slice(0, MAX_PAIRS_PER_RUN), dropped: Math.max(0, all.length - MAX_PAIRS_PER_RUN) };
}

function storyLines(item: MergeCandidate, label: "A" | "B"): string {
  const headline = item.cluster.articles[0]?.title;
  const headlineLine =
    typeof headline === "string" && headline.trim() !== ""
      ? `\n   Headline: ${flatten(headline, HEADLINE_CHARS)}`
      : "";
  return `${label}: ${usableEvent(item) ?? ""}${headlineLine}`;
}

function buildParams(items: readonly MergeCandidate[], pairs: readonly CandidatePair[]) {
  const list = pairs
    .map((pair, k) => `${k}.\n${storyLines(items[pair.a], "A")}\n${storyLines(items[pair.b], "B")}`)
    .join("\n\n");
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: `Pairs:\n\n${list}\n\nFor each numbered pair: do A and B report the same real-world event?`,
      },
    ],
    output_config: { format: zodOutputFormat(verdictSchema) },
  } satisfies Parameters<typeof client.messages.parse>[0];
}

/**
 * The pair numbers Haiku called the same event; every other pair it was asked
 * about counts as refused, an unanswered one included. Never throws: a failed,
 * timed-out, truncated or unparseable call returns an empty set, so nothing it
 * was asked about merges. recordCall still records the attempt, billed or not.
 */
async function askSameEvent(
  params: ReturnType<typeof buildParams>,
  pairCount: number,
): Promise<Set<number>> {
  const same = new Set<number>();
  try {
    const response = await recordCall("merge", MODEL, () => client.messages.parse(params), boundOf(params, client.maxRetries + 1));
    if (!response.parsed_output) {
      bestEffortLog("error", `[merge] same-event check returned no verdicts (stop_reason: ${response.stop_reason}); merging nothing`);
      return same;
    }
    // Out-of-range numbers dropped and the first verdict for a number wins,
    // as in triage: a verdict must never land on a pair it wasn't about.
    const seen = new Set<number>();
    for (const verdict of response.parsed_output.verdicts) {
      if (!Number.isInteger(verdict.pair) || verdict.pair < 0 || verdict.pair >= pairCount) continue;
      if (seen.has(verdict.pair)) continue;
      seen.add(verdict.pair);
      if (verdict.same === true) same.add(verdict.pair);
    }
  } catch (err) {
    bestEffortLog("error", "[merge] same-event check failed; merging nothing it was asked about:", err);
    same.clear();
  }
  return same;
}

/** Triage's own grade, before any preferred-source boost. */
function gradeOf(item: MergeCandidate): number {
  return item.triageSeverity ?? item.severity;
}

/** Position of a cluster's unit in the order the digest reads units; unknown last. */
function unitRank(cluster: Cluster, unitOrder: readonly ReadingUnit[]): number {
  const subtopic = subtopicOf(cluster);
  const found = unitOrder.findIndex((u) => u.topic === cluster.topic && (u.subtopic ?? null) === subtopic);
  return found === -1 ? Number.POSITIVE_INFINITY : found;
}

/**
 * Applies the pairs Haiku confirmed. Transitive (A=B and B=C make one group)
 * through union-find, except that a pair Haiku was asked about and did not
 * confirm can never end up in one group: a chain through a bridging story (a
 * roundup of two central banks' decisions) must not override an explicit
 * "different events". Confirmed pairs are applied in the order given (highest
 * score first), and one that would join a refused pair is skipped.
 *
 * Deterministic: each group is kept in the member with the higher triage
 * severity, then more articles, then the earlier reading unit, then the
 * earlier position. That member's unit and severity are the merged cluster's;
 * the others' articles are added after its own, skipping any the group
 * already holds under the same normalised URL.
 */
export function applyMerges<T extends MergeCandidate>(
  items: readonly T[],
  confirmed: readonly CandidatePair[],
  unitOrder: readonly ReadingUnit[],
  refused: readonly CandidatePair[] = [],
): {
  items: T[];
  merged: number;
  groups: { keeper: number; absorbed: number[] }[];
  /** The confirmed pairs actually joined; a skipped one is left out. */
  applied: CandidatePair[];
} {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const applied: CandidatePair[] = [];
  for (const pair of confirmed) {
    const ra = find(pair.a);
    const rb = find(pair.b);
    if (ra === rb) {
      applied.push(pair);
      continue;
    }
    const joinsRefused = refused.some(({ a, b }) => {
      const [x, y] = [find(a), find(b)];
      return (x === ra && y === rb) || (x === rb && y === ra);
    });
    if (joinsRefused) continue;
    parent[Math.max(ra, rb)] = Math.min(ra, rb);
    applied.push(pair);
  }

  const members = new Map<number, number[]>();
  items.forEach((_, i) => {
    const root = find(i);
    const list = members.get(root);
    if (list) list.push(i);
    else members.set(root, [i]);
  });

  const rank = (x: number, y: number) =>
    gradeOf(items[y]) - gradeOf(items[x]) ||
    items[y].cluster.articles.length - items[x].cluster.articles.length ||
    unitRank(items[x].cluster, unitOrder) - unitRank(items[y].cluster, unitOrder) ||
    x - y;

  const replacement = new Map<number, T>();
  const absorbedSet = new Set<number>();
  const groups: { keeper: number; absorbed: number[] }[] = [];
  for (const group of members.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(rank);
    const [keeper, ...absorbed] = ordered;

    const seen = new Set<string>();
    const articles: Article[] = [];
    for (const index of ordered) {
      for (const article of items[index].cluster.articles) {
        const key = normalizeArticleUrl(article.url);
        if (key !== null) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        articles.push(article);
      }
    }

    // The group's highest grades: the card is written at triage's own grade
    // (triageSeverity when a member was boosted), as every card is.
    const severity = Math.max(...ordered.map((i) => items[i].severity));
    const boostedMember = ordered.some((i) => items[i].triageSeverity !== undefined);
    replacement.set(keeper, {
      ...items[keeper],
      cluster: { ...items[keeper].cluster, articles },
      severity,
      ...(boostedMember ? { triageSeverity: Math.max(...ordered.map((i) => gradeOf(items[i]))) } : {}),
    });
    for (const index of absorbed) absorbedSet.add(index);
    groups.push({ keeper, absorbed });
  }

  const out: T[] = [];
  items.forEach((item, i) => {
    if (absorbedSet.has(i)) return;
    out.push(replacement.get(i) ?? item);
  });
  return { items: out, merged: absorbedSet.size, groups, applied };
}

/**
 * One best-effort line per absorbed cluster, naming the applied pair that
 * scored highest for it. Runs after a billed call, so it can never throw.
 */
function logMerges(
  items: readonly MergeCandidate[],
  groups: readonly { keeper: number; absorbed: number[] }[],
  confirmed: readonly CandidatePair[],
): void {
  for (const { keeper, absorbed } of groups) {
    for (const index of absorbed) {
      try {
        const score = Math.max(
          ...confirmed.filter((p) => p.a === index || p.b === index).map((p) => p.score),
        );
        bestEffortLog(
          "log",
          `[merge] ${unitLabel(items[keeper].cluster)} ← ${unitLabel(items[index].cluster)}: "${flatten(items[index].event ?? "", EVENT_CHARS).replace(/"/g, "'")}" (${score.toFixed(3)}, haiku)`,
        );
      } catch {
        // A lost log line must not cost a paid merge.
      }
    }
  }
}

/**
 * Merges notable clusters that report the same real-world event, before any
 * card is written, so one card is paid for and it cites every outlet.
 *
 * Only notable clusters with an event sentence take part; rejected and
 * fail-closed clusters pass through untouched. With fewer than two sentences
 * nothing is embedded and nothing is called, so a run without sentences is
 * exactly what it was before this step existed.
 *
 * Never rejects. Any failure (the embedding, the call, building the result)
 * returns the clusters unmerged: a duplicate card is a far smaller cost than a
 * lost digest. `haikuCalls` says whether the call was actually started, so the
 * run's expected-call count matches what the collector should have recorded.
 */
export async function mergeDuplicateClusters<T extends MergeCandidate>(
  items: readonly T[],
  unitOrder: readonly ReadingUnit[],
): Promise<MergeResult<T>> {
  let haikuCalls: 0 | 1 = 0;
  const startedAt = Date.now();
  try {
    const eligible: number[] = [];
    const sentences: string[] = [];
    items.forEach((item, i) => {
      const event = usableEvent(item);
      if (event !== null) {
        eligible.push(i);
        sentences.push(event);
      }
    });
    if (eligible.length < 2) return { items: [...items], merged: 0, haikuCalls };

    const vectors = await embed(sentences);
    const { pairs, dropped } = candidatePairs(eligible, vectors);
    if (dropped > 0) {
      bestEffortLog("warn", `[merge] ${pairs.length + dropped} candidate pairs; asking about the top ${pairs.length}, the rest stay separate`);
    }
    if (pairs.length === 0) return { items: [...items], merged: 0, haikuCalls };

    const params = buildParams(items, pairs);
    haikuCalls = 1;
    const same = await askSameEvent(params, pairs.length);
    const confirmed = pairs.filter((_, k) => same.has(k));
    const refused = pairs.filter((_, k) => !same.has(k));
    bestEffortLog(
      "log",
      `[merge] asked about ${pairs.length} pair(s) from ${eligible.length} sentences, ${confirmed.length} same event (${Date.now() - startedAt} ms)`,
    );
    if (confirmed.length === 0) return { items: [...items], merged: 0, haikuCalls };

    const result = applyMerges(items, confirmed, unitOrder, refused);
    logMerges(items, result.groups, result.applied);
    return { items: result.items, merged: result.merged, haikuCalls };
  } catch (err) {
    bestEffortLog("error", "[merge] duplicate check failed; writing every cluster as it is:", err);
    return { items: [...items], merged: 0, haikuCalls };
  }
}
