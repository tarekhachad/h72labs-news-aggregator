import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Cluster, Topic } from "@/types";
import { embed, cosineSimilarity } from "@/lib/embeddings";
import { recordCall } from "@/lib/usageCollector";

const client = new Anthropic();

// Looser than cluster.ts's SIMILARITY_THRESHOLD (0.65) — that constant's own
// comment documents real same-story pairs scoring as low as 0.634-0.70, i.e.
// a threshold tuned for confident auto-merging already sits close to where
// real duplicates start scoring. This gate only decides "worth asking
// Haiku," not "confident match," so erring low favors recall (catching more
// real duplicates as candidates) at the cost of a few extra cheap Haiku
// calls on non-duplicates — a good trade given the alternative is silently
// re-covering an already-covered story. Revisit empirically once live, same
// as SIMILARITY_THRESHOLD was tuned.
const DUPLICATE_CANDIDATE_THRESHOLD = 0.5;

const SameStoryResult = z.object({
  sameStory: z.boolean(),
});

const SYSTEM_PROMPT = `You're checking whether a candidate news story has already been covered in today's briefing. Given a short summary of a story already in today's briefing, and the source coverage for a new candidate story, decide: are these genuinely the same real-world story (even if worded differently, or the candidate is a follow-up/update on the same event), or are they actually different stories? Judge the underlying event, not surface wording — two articles about the same transfer, ruling, or incident are the same story even from different outlets or with new details added. A related-but-distinct development (e.g. a new, separate incident in an ongoing conflict) is NOT the same story.`;

// Capped per article, same spirit as triage.ts's 200-char snippet slice —
// without this, a large cluster's concatenated text grows unbounded (both
// pricier to send to Haiku, and risking the embedding model silently
// truncating so only the first article or two actually shape the vector).
const SNIPPET_CHARS_PER_ARTICLE = 200;

function clusterText(cluster: Cluster): string {
  return cluster.articles
    .map((a) => `${a.title}. ${a.snippet.slice(0, SNIPPET_CHARS_PER_ARTICLE)}`)
    .join(" ");
}

/**
 * One Haiku call, same tier as triage's batched calls but still one per
 * candidate — asks whether a candidate cluster is the same real-world story
 * as an already-covered card. Deliberately fails open (returns false, i.e.
 * "let it through") on any error: the opposite of triageClusters'
 * fail-closed convention. Fail-closed there suppresses noise on
 * uncertainty, which is the safe default for that decision; here, dropping
 * a cluster on uncertainty risks silently
 * losing a genuinely new, notable story, which is worse than occasionally
 * showing a duplicate a user can just ignore.
 */
export async function isSameStory(
  candidateText: string,
  existingSummary: string
): Promise<boolean> {
  try {
    const response = await recordCall("dedup", "claude-haiku-4-5", () =>
      client.messages.parse({
        model: "claude-haiku-4-5",
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Already in today's briefing:\n${existingSummary}\n\nCandidate story's source coverage:\n${candidateText}\n\nIs the candidate the same real-world story as what's already in today's briefing?`,
          },
        ],
        output_config: { format: zodOutputFormat(SameStoryResult) },
      })
    );

    return response.parsed_output?.sameStory ?? false;
  } catch (err) {
    console.error("[dedup] isSameStory failed, letting the cluster through:", err);
    return false;
  }
}

/**
 * Filters out clusters that are the same real-world story as a card already
 * persisted earlier today, so a second/third same-day "Complete today's
 * news" run doesn't re-cover a story that's already on the digest. Compares
 * only within the same topic, and only against today's cards (an evolving
 * story getting fresh daily coverage on a later day is normal, not a bug).
 * Two-stage, mirroring the same reasoning ROADMAP.md's deferred entry
 * already worked through for same-run near-duplicates: a cheap embedding
 * pre-filter narrows candidates, then Haiku confirms borderline ones —
 * a pure similarity threshold can't reliably separate "same story" from
 * "different story" on its own (see DUPLICATE_CANDIDATE_THRESHOLD's comment).
 */
export async function filterAlreadyCovered(
  clusters: Cluster[],
  existingCards: { topic: Topic; shortSummary: string }[]
): Promise<Cluster[]> {
  if (existingCards.length === 0) return clusters;

  // Computed once per cluster and reused for both the embedding batch below
  // and the isSameStory call further down, instead of rebuilding the same
  // string twice.
  const texts = clusters.map(clusterText);

  const topics = new Set(clusters.map((c) => c.topic));
  const survivingByIndex = new Array<boolean>(clusters.length).fill(true);

  // Topics are independent of each other, so process them concurrently.
  // This fan-out is one group per topic, however many clusters that topic
  // holds — deliberately NOT the same shape as triageClusters' batching,
  // which splits a topic further into ≤20-cluster batches. The inner
  // `checks` fan-out below is the one to compare against triage: it still
  // issues one Haiku call per candidate cluster, unbatched, which is
  // exactly the one-call-per-item pattern F.4.5 removed from triage and
  // did not touch here. See ROADMAP.md's deferred section.
  await Promise.all(
    Array.from(topics).map(async (topic) => {
      const topicClusterIndices = clusters
        .map((c, i) => (c.topic === topic ? i : -1))
        .filter((i) => i !== -1);
      const topicCards = existingCards.filter((c) => c.topic === topic);
      if (topicCards.length === 0) return;

      const [clusterVectors, cardVectors] = await Promise.all([
        embed(topicClusterIndices.map((i) => texts[i])),
        embed(topicCards.map((c) => c.shortSummary)),
      ]);

      const checks = topicClusterIndices.map(async (clusterIdx, vecIdx) => {
        const vector = clusterVectors[vecIdx];

        // Best-match, not first-match — same precedent as cluster.ts's own
        // clustering logic: compare against every existing card and take the
        // one it's actually closest to, not whichever comes first.
        let bestSimilarity = -Infinity;
        let bestCardIdx = -1;
        cardVectors.forEach((cardVector, cardIdx) => {
          const similarity = cosineSimilarity(vector, cardVector);
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestCardIdx = cardIdx;
          }
        });

        if (bestSimilarity < DUPLICATE_CANDIDATE_THRESHOLD) return;

        const same = await isSameStory(texts[clusterIdx], topicCards[bestCardIdx].shortSummary);
        if (same) {
          survivingByIndex[clusterIdx] = false;
          console.log(
            `[dedup] ${topic} — excluded as already covered (similarity ${bestSimilarity.toFixed(3)})`
          );
        }
      });

      await Promise.all(checks);
    })
  );

  return clusters.filter((_, i) => survivingByIndex[i]);
}
