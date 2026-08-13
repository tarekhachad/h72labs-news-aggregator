import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Cluster, Topic } from "@/types";
import { recordCall } from "@/lib/usageCollector";

const client = new Anthropic();

export interface TriageOutcome {
  notable: boolean;
  severity: number;
}

/**
 * The verdict every unjudged cluster falls back to. Fail-closed: an
 * unjudged cluster is dropped from the brief rather than written up
 * unreviewed, matching the per-cluster convention this module has always
 * had (F.3 measured triage at 65% of spend precisely because it gates the
 * expensive Sonnet step — letting an unjudged cluster through would spend
 * Sonnet money on something nothing has vetted).
 */
// Frozen because one shared reference is handed to every unjudged cluster
// in a response. Nothing mutates a TriageOutcome today (the route reads the
// two fields into fresh objects), but if anything ever did, a single
// in-place write would silently rewrite the verdict of every other
// fail-closed cluster in the same digest. Same hazard usage.ts's frozen
// ZERO_TOKENS singleton exists to prevent.
const FAIL_CLOSED: TriageOutcome = Object.freeze({
  notable: false,
  severity: 1,
});

/**
 * Clusters per batch. F.3's cost analysis found triage was 65% of a
 * digest's spend with 91% of its input pure repetition — ~770 tokens of
 * fixed prompt and schema re-sent against ~80 tokens of actual content,
 * once per cluster. Prompt caching can't help: Haiku 4.5's minimum
 * cacheable prefix is 4,096 tokens against a ~600-token prompt. The only
 * lever is call count, which this constant is.
 *
 * 20 rather than more: the cost curve is nearly flat past this point
 * (20→40 saves a further ~$0.013) while doubling how much a single failed
 * batch has to re-do. Output binds the ceiling too — 20 verdicts at ~24
 * tokens plus wrapper is ~490 against MAX_TOKENS below, roughly 2x
 * headroom.
 */
const MAX_CLUSTERS_PER_BATCH = 20;

/**
 * Output ceiling, sized per mode because reasons roughly double a verdict.
 *
 * Without reasons: 20 verdicts of ~24 tokens plus wrapper is ~490, so 1024
 * is a little over 2x headroom. With reasons, a verdict carries an extra
 * ~12-word field — call it ~40 tokens all-in — so a full batch lands near
 * 900, which against 1024 is ~1.1x. That is not enough: the 12-word cap is
 * a prompt instruction, not a schema constraint (deliberately — see
 * verdictSchema), and models overrun soft caps. Truncation still fails
 * safe through the split-retry ladder, but it would burn paid retries
 * during exactly the calibration run reasons exist for.
 *
 * Raising the ceiling costs nothing when it isn't reached: output tokens
 * are billed as generated, not as budgeted.
 */
const MAX_TOKENS = 1024;
const MAX_TOKENS_WITH_REASONS = 2048;

/**
 * How many times a failing batch may be halved before its residue is
 * failed closed: 20 → 2x10 → 4x5, a bounded worst case of 7 calls, and
 * only ever on a failure path. Without this, batching would turn "one
 * failure loses one cluster" into "one failure loses twenty" — permanently,
 * since the since-cursor advances whether or not a cluster was judged.
 */
const MAX_SPLIT_DEPTH = 2;

/**
 * Per-verdict reasons are the only way to inspect the model's calibration
 * without re-running Haiku by hand, but they're pure output tokens — ~$0.06
 * a digest at F.3's measured volume. Off by default, on for a calibration
 * run (F.4.6 uses this). Read per call, not at module load, so a test or a
 * single run can flip it without a reimport.
 */
function reasonsEnabled(): boolean {
  return process.env.TRIAGE_REASONS === "1";
}

const SYSTEM_PROMPT = `You triage news clusters for someone's personalized daily news brief. They've chosen specific topics to follow, and each cluster you review belongs to one of them (given below). The brief is short and curated — a handful of genuinely worthwhile items per topic, not a comprehensive scan of everything published that day.

Judge notability relative to the topic itself, not against world-historical importance: would someone who actively chose to follow this specific topic consider this a real, meaningful development worth knowing about today? Calibrate to that topic's own scale — a major tournament result or a significant transfer is genuinely notable within a sports topic even though it would never belong in a geopolitical briefing; a landmark court ruling or a major diplomatic development is notable within a politics topic. Judge each cluster against its own topic's standard, not one universal bar. Concretely: imagine a typical day's worth of coverage for this exact topic — would this cluster be one of the more significant items in that typical day, or would it blend into the background as routine? Each cluster is judged independently, so anchor against that typical-day baseline rather than against other clusters you happen to see in the same batch.

Reject: routine or incremental updates with nothing new resolved, opinion or analysis pieces, minor process stories with no real development, and anything you'd only include for completeness rather than because someone following this topic needs to hear it today.

When genuinely torn, reject — a focused, honest brief beats a padded one. If a topic genuinely has nothing worth including today, that's a true and useful signal to surface, not a failure to correct — don't stretch to fill a quota.

If the cluster is notable, also grade how significant it is relative to this topic's own typical-day baseline, on a 1-5 scale:
5 = the most significant kind of development this topic sees even at its rarest peak.
4 = a major development, clearly above a typical day's best story.
3 = a clear highlight of a typical day — the kind of thing that anchors the brief for this topic today.
2 = solidly notable, but a lesser item on a day that also has bigger news for this topic.
1 = the least significant thing that still genuinely clears the notability bar above.
If you reject the cluster, severity doesn't matter — return 1.

You are given several numbered clusters at once. Return exactly one verdict per cluster, each carrying the number it was given. Never merge two clusters into one verdict, never skip a cluster because it resembles another, and never invent a number you weren't given. The numbering exists only to match verdicts back to clusters — it carries no ranking or ordering meaning, and judging each cluster independently against its topic's typical day still applies exactly as described above.`;

const REASON_INSTRUCTION = `\n\nFor each verdict also give a reason of at most 12 words.`;

function verdictSchema(withReasons: boolean) {
  const verdict = withReasons
    ? z.object({
        index: z.number().int(),
        notable: z.boolean(),
        severity: z.number().int().min(1).max(5),
        // Deliberately not z.string().max(): a length violation would fail
        // schema validation and take down a whole batch's worth of already-
        // paid-for verdicts over a diagnostic field. The cap is instructed
        // in the prompt instead, where overrunning it costs a few tokens.
        reason: z.string(),
      })
    : z.object({
        index: z.number().int(),
        notable: z.boolean(),
        severity: z.number().int().min(1).max(5),
      });

  return z.object({ verdicts: z.array(verdict) });
}

export interface TriageBatch {
  topic: Topic;
  /** Indices into the original clusters array. */
  indices: number[];
}

/**
 * Groups clusters into the batches triage will actually send: per-topic,
 * then split into size-evened chunks.
 *
 * Per-topic because the prompt's whole calibration is topic-relative
 * ("a typical day's coverage for this exact topic") — mixing topics in one
 * call would ask the model to hold several different bars at once. The
 * extra partial calls that costs are worth ~$0.006.
 *
 * Size-evened because `ceil(n / MAX)`-sized chunks leave a runt: 62
 * clusters would go 20/20/20/2, and a 2-cluster batch is judged at a very
 * different context density than a 20-cluster one. Computing the batch
 * count first and dividing back gives 16/16/15/15 instead.
 *
 * Exported so the cost instrumentation can predict the call count from the
 * same function that produces the batches, rather than a second copy of
 * this arithmetic that could drift and make the module whose premise is
 * "a confidently wrong number is worse than a crash" emit false warnings.
 */
export function planTriageBatches(clusters: Cluster[]): TriageBatch[] {
  const byTopic = new Map<Topic, number[]>();
  clusters.forEach((cluster, index) => {
    const existing = byTopic.get(cluster.topic);
    if (existing) existing.push(index);
    else byTopic.set(cluster.topic, [index]);
  });

  const batches: TriageBatch[] = [];
  for (const [topic, indices] of byTopic) {
    const batchCount = Math.ceil(indices.length / MAX_CLUSTERS_PER_BATCH);
    // Distribute the remainder one cluster at a time across the leading
    // batches rather than slicing at a fixed stride — a fixed stride of
    // ceil(n / batchCount) doesn't even anything out, it just relocates the
    // runt to the end (62 would go 16/16/16/14 instead of 16/16/15/15).
    const base = Math.floor(indices.length / batchCount);
    const remainder = indices.length % batchCount;

    let start = 0;
    for (let b = 0; b < batchCount; b += 1) {
      const size = base + (b < remainder ? 1 : 0);
      batches.push({ topic, indices: indices.slice(start, start + size) });
      start += size;
    }
  }

  return batches;
}

/** How many Claude calls a clean triage pass will make for these clusters. */
export function triageBatchCount(clusters: Cluster[]): number {
  return planTriageBatches(clusters).length;
}

function clusterContext(cluster: Cluster): string {
  return cluster.articles
    .map((a) => `- ${a.title}\n  ${a.snippet.slice(0, 200)}`)
    .join("\n");
}

/**
 * One Claude call judging `indices` (all of one topic), returning only the
 * verdicts it could confidently match back. Callers treat anything absent
 * from the returned map as unjudged — that's what drives the split-retry
 * ladder rather than a silent rejection.
 *
 * Throws when the underlying call fails (network, rate limit, SDK error —
 * recordCall records the attempt and rethrows), and when the response
 * arrives missing or unparseable. That second case is the one worth
 * stating: a truncated response is not a judgement of "not notable," so it
 * routes through the caller's catch and gets those clusters retried rather
 * than silently dropped.
 */
async function judgeBatch(
  clusters: Cluster[],
  indices: number[],
  topic: Topic,
): Promise<Map<number, TriageOutcome>> {
  const withReasons = reasonsEnabled();
  const list = indices
    .map(
      (clusterIdx, batchIdx) =>
        `${batchIdx}. ${clusterContext(clusters[clusterIdx])}`,
    )
    .join("\n\n");

  const response = await recordCall("triage", "claude-haiku-4-5", () =>
    client.messages.parse({
      model: "claude-haiku-4-5",
      max_tokens: withReasons ? MAX_TOKENS_WITH_REASONS : MAX_TOKENS,
      system: withReasons ? SYSTEM_PROMPT + REASON_INSTRUCTION : SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Topic: ${topic}\n\nClusters:\n\n${list}\n\nFor each numbered cluster: does it belong in today's briefing, and how significant is it relative to this topic's own typical-day baseline?`,
        },
      ],
      output_config: { format: zodOutputFormat(verdictSchema(withReasons)) },
    }),
  );

  if (!response.parsed_output) {
    throw new Error(
      `triage: no parsed output for ${topic} batch of ${indices.length} (stop_reason: ${response.stop_reason})`,
    );
  }

  // Batch-local index -> cluster index, following rank.ts's precedent:
  // out-of-range dropped, duplicates first-wins, missing slots simply left
  // absent. A model that returns 19 verdicts for 20 clusters must not
  // silently shift the 20th cluster's verdict onto the 19th.
  const outcomes = new Map<number, TriageOutcome>();
  const seen = new Set<number>();
  for (const verdict of response.parsed_output.verdicts) {
    if (verdict.index < 0 || verdict.index >= indices.length) continue;
    if (seen.has(verdict.index)) continue;
    seen.add(verdict.index);
    outcomes.set(indices[verdict.index], {
      notable: verdict.notable,
      severity: verdict.severity,
    });

    // Built outside the guard below on purpose. The guard exists for one
    // thing — console.log itself failing — and widening it to cover this
    // lookup would swallow a genuine TypeError too, quietly turning "the
    // index mapping is broken" into "a log line went missing." The
    // range check above is what guarantees this lookup resolves.
    const cluster = clusters[indices[verdict.index]];
    const reason = "reason" in verdict ? ` — ${verdict.reason}` : "";
    const line = `[triage] ${cluster.topic} — ${verdict.notable ? `PASS (severity ${verdict.severity})` : "reject"}${reason}`;

    // Guarded: this runs after the call has resolved and been billed, so an
    // unguarded throw here would be indistinguishable from the API call
    // failing and would send 20 already-paid-for verdicts back through the
    // retry ladder. Same reasoning as usageCollector.ts's guarded logging;
    // ROADMAP.md tracks the remaining unguarded instances of this shape.
    try {
      console.log(line);
    } catch {
      // A lost log line must not cost a paid verdict.
    }
  }

  return outcomes;
}

/**
 * Judges `indices`, halving and retrying whatever comes back unjudged,
 * down to MAX_SPLIT_DEPTH. Never throws — anything still unjudged at the
 * bottom is simply absent from the returned map, and the caller fails it
 * closed.
 */
async function judgeWithSplitRetry(
  clusters: Cluster[],
  indices: number[],
  topic: Topic,
  depth: number,
): Promise<Map<number, TriageOutcome>> {
  let outcomes = new Map<number, TriageOutcome>();

  try {
    outcomes = await judgeBatch(clusters, indices, topic);
  } catch (err) {
    // Guarded for the same reason judgeBatch's log is, and it matters more
    // here: this catch is the only thing standing between a failed batch
    // and triageClusters rejecting. An unguarded throw from the logger
    // would escape this catch, propagate through the Promise.all in
    // triageClusters, and break the never-rejects contract that the route
    // gave up its own per-cluster catch to rely on — turning one failed
    // batch into a failed digest.
    try {
      console.error(
        `[triage] batch of ${indices.length} for ${topic} failed:`,
        err,
      );
    } catch {
      // Deliberately empty: the batch is already being handled by falling
      // through to the split-retry below.
    }
  }

  const unjudged = indices.filter((i) => !outcomes.has(i));
  if (unjudged.length === 0 || depth >= MAX_SPLIT_DEPTH) return outcomes;

  // Halve rather than retry whole: a batch that failed for a size-related
  // reason (truncated output, an over-long cluster) would just fail again
  // at the same size. Both halves are attempted — one bad cluster
  // shouldn't cost the other half its verdicts.
  const mid = Math.ceil(unjudged.length / 2);
  const halves = [unjudged.slice(0, mid), unjudged.slice(mid)].filter(
    (h) => h.length > 0,
  );
  const retried = await Promise.all(
    halves.map((half) => judgeWithSplitRetry(clusters, half, topic, depth + 1)),
  );

  for (const map of retried) {
    for (const [index, outcome] of map) outcomes.set(index, outcome);
  }

  return outcomes;
}

/**
 * Triages every cluster, returning one outcome per input cluster in input
 * order. Replaces the previous one-call-per-cluster pass: F.3 measured 794
 * triage calls for a single digest at 65% of its cost, with 91% of the
 * input being the same prompt bytes re-sent each time.
 *
 * Never rejects. The digest route used to wrap each cluster in its own
 * try/catch so one failure couldn't take down the run; with batching that
 * guarantee has to live in here instead, because a rejection would now
 * discard a whole batch rather than one cluster.
 */
export async function triageClusters(
  clusters: Cluster[],
): Promise<TriageOutcome[]> {
  if (clusters.length === 0) return [];

  const batches = planTriageBatches(clusters);
  const results = await Promise.all(
    batches.map((batch) =>
      judgeWithSplitRetry(clusters, batch.indices, batch.topic, 0),
    ),
  );

  const merged = new Map<number, TriageOutcome>();
  for (const map of results) {
    for (const [index, outcome] of map) merged.set(index, outcome);
  }

  return clusters.map((_, i) => merged.get(i) ?? FAIL_CLOSED);
}
