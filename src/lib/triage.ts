import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Cluster } from "@/types";

const client = new Anthropic();

const TriageResult = z.object({
  notable: z.boolean(),
  // 1-5. Only meaningful when notable is true — a rejected cluster's
  // severity is never persisted (writeCard is never called for it), so
  // there's no need to constrain what the model returns for a reject.
  severity: z.number().int().min(1).max(5),
  reason: z.string(),
});

export interface TriageOutcome {
  notable: boolean;
  severity: number;
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
If you reject the cluster, severity doesn't matter — return 1.`;

/**
 * One cheap Haiku call per cluster — filters out noise before the
 * expensive Sonnet writing step, and grades what survives so the frontend
 * can size it relative to other stories in the same topic.
 */
export async function triageCluster(cluster: Cluster): Promise<TriageOutcome> {
  const context = cluster.articles
    .map((a) => `- ${a.title}\n  ${a.snippet.slice(0, 200)}`)
    .join("\n");

  const response = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Topic: ${cluster.topic}\n\nCoverage of this cluster:\n${context}\n\nDoes this belong in today's briefing? If so, how significant is it relative to this topic's own typical-day baseline?`,
      },
    ],
    output_config: { format: zodOutputFormat(TriageResult) },
  });

  const result = response.parsed_output ?? {
    notable: false,
    severity: 1,
    reason: "(no parsed output)",
  };
  // Reason is otherwise discarded — logging it is cheap and is the only
  // way to inspect the model's calibration without re-running Haiku calls
  // by hand, especially useful while the topic-relative bar is still new.
  console.log(
    `[triage] ${cluster.topic} — ${result.notable ? `PASS (severity ${result.severity})` : "reject"} — ${result.reason}`
  );

  return { notable: result.notable, severity: result.severity };
}
