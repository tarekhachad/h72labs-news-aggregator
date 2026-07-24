import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Cluster } from "@/types";

const client = new Anthropic();

const TriageResult = z.object({
  notable: z.boolean(),
  reason: z.string(),
});

const SYSTEM_PROMPT = `You triage news clusters for a head of state's morning briefing. That briefing is short — a handful of items the person genuinely needs to know before starting their day, not a comprehensive scan of everything published. Most clusters you see should be rejected.

Mark "notable" only for: major geopolitical developments (conflict, diplomacy, war, elections, mass casualties); market- or industry-moving events at real scale (large M&A, major earnings surprises, landmark regulatory rulings, significant new laws or sanctions); and events that would visibly change public understanding or behavior (major product launches from dominant players, significant safety/security incidents, landmark court rulings).

Reject: routine corporate updates (ordinary earnings, minor product tweaks, funding rounds below the largest deals, personnel changes at non-top-tier roles), incremental legal/political process stories with no resolution, opinion or analysis pieces, minor regional stories without broader stakes, and anything you'd only include for completeness rather than because a busy, well-informed person needs to hear it today.

When genuinely torn, reject — the cost of missing a borderline story is much lower than the cost of a bloated, unfocused briefing.`;

/**
 * One cheap Haiku call per cluster — filters out noise before the
 * expensive Sonnet writing step.
 */
export async function triageCluster(cluster: Cluster): Promise<boolean> {
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
        content: `Topic: ${cluster.topic}\n\nCoverage of this cluster:\n${context}\n\nDoes this belong in today's briefing?`,
      },
    ],
    output_config: { format: zodOutputFormat(TriageResult) },
  });

  return response.parsed_output?.notable ?? false;
}
