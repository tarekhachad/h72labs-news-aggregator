import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Topic } from "@/types";
import { recordCall } from "@/lib/usageCollector";

const client = new Anthropic();

// Same spirit as triage.ts's 200-char snippet slice and dedup.ts's
// SNIPPET_CHARS_PER_ARTICLE — a candidate's text here is already a
// synthesized shortSummary (denser than a raw article snippet), so this is
// a bit more generous, but the candidate pool accumulates across a whole
// day's multiple runs (many topics x several runs x a handful of cards
// each), so leaving it fully unbounded risks real token-cost growth on a
// heavy-usage day without this cap.
const SUMMARY_CHARS_PER_CANDIDATE = 300;

const RankResult = z.object({
  picks: z.array(
    z.object({
      index: z.number().int(),
      rank: z.number().int().min(1).max(6),
    })
  ),
});

const SYSTEM_PROMPT = `You pick today's front page for a personalized daily news brief — the handful of stories, drawn across every topic the reader follows, that matter most today overall. You'll be given a numbered list of candidate stories, each already judged notable within its own topic and given a severity (1-5) relative to that topic's own typical-day baseline. Severity is a same-topic signal only — a 5 in one topic and a 5 in another aren't necessarily equally significant on an absolute, cross-topic scale, so read each story's actual content, not just its severity number, when comparing across topics.

Pick up to 6 stories for the front page, ranked 1 (most significant overall) through 6. Prefer genuine breadth when candidates are close in significance — a front page that's all one topic is a worse front page than one that reflects what the reader actually follows, all else equal. Fewer than 6 is fine and expected on a quiet day; do not pad the list with stories that don't belong.

Respond with the index (from the numbered list) and rank (1-6) of each pick — nothing else.`;

/**
 * One Claude call for the WHOLE candidate pool, not a per-item Promise.all
 * like triageCluster/isSameStory — ranking is inherently a cross-cluster
 * comparison (this candidate vs. every other one), unlike those two, whose
 * judgments are genuinely independent per item. This also means it can't
 * compound the pipeline's existing unbounded-triage-concurrency risk (see
 * ROADMAP.md's deferred section) the way a per-item version would.
 *
 * Fails open, mirroring dedup.ts's isSameStory rather than triageCluster's
 * fail-closed convention: this is a refinement layer on top of core
 * notability filtering (already done by triage), not the safety-critical
 * suppression decision triage is. Returns null (not a partial array) on
 * any failure — the caller's contract is that null means "ranking didn't
 * happen this run, leave every existing rank untouched," which a partial
 * or all-null array can't distinguish from "these candidates were actually
 * considered and none of them made the front page."
 */
export async function rankFrontPage(
  candidates: { topic: Topic; severity: number; text: string }[]
): Promise<(number | null)[] | null> {
  if (candidates.length === 0) return [];

  try {
    const list = candidates
      .map(
        (c, i) =>
          `${i}. [${c.topic}, severity ${c.severity}] ${c.text.slice(0, SUMMARY_CHARS_PER_CANDIDATE)}`
      )
      .join("\n\n");

    const response = await recordCall("rank", "claude-haiku-4-5", () =>
      client.messages.parse({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Candidate stories:\n\n${list}\n\nWhich belong on today's front page, and in what order?`,
          },
        ],
        output_config: { format: zodOutputFormat(RankResult) },
      })
    );

    if (!response.parsed_output) {
      // A missing parsed_output isn't the same thing as "the model
      // legitimately picked nothing" (an empty picks array) — it also
      // covers a truncated/unparseable response (e.g. max_tokens cut off
      // the JSON mid-object). Treating it as "zero picks" would silently
      // return an all-null array indistinguishable from a real ranking
      // result, defeating the whole point of the null-vs-array distinction
      // this function's contract depends on. Throwing here routes it
      // through the same catch block as any other failure, correctly
      // returning the null fail-open sentinel instead.
      throw new Error(`rankFrontPage: no parsed output (stop_reason: ${response.stop_reason})`);
    }

    const picks = response.parsed_output.picks;
    const result = new Array<number | null>(candidates.length).fill(null);
    const seenIndices = new Set<number>();
    const seenRanks = new Set<number>();

    for (const pick of picks) {
      if (pick.index < 0 || pick.index >= candidates.length) continue;
      if (seenIndices.has(pick.index) || seenRanks.has(pick.rank)) continue;
      result[pick.index] = pick.rank;
      seenIndices.add(pick.index);
      seenRanks.add(pick.rank);
    }

    return result;
  } catch (err) {
    console.error("[rank] rankFrontPage failed, leaving today's front page unchanged:", err);
    return null;
  }
}
