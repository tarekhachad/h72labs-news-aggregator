import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Cluster } from "@/types";

const client = new Anthropic();

const TriageResult = z.object({
  notable: z.boolean(),
  reason: z.string(),
});

const SYSTEM_PROMPT = `You triage news clusters for a daily briefing, in the style a head-of-state's staff would use to decide what makes the cut. A cluster is "notable" if it represents a distinct, meaningful event — not routine coverage, listicles, opinion pieces, or minor updates. Be selective.`;

/**
 * One cheap Haiku call per cluster — filters out noise before the
 * expensive Sonnet writing step.
 */
export async function triageCluster(cluster: Cluster): Promise<boolean> {
  const headlines = cluster.articles.map((a) => `- ${a.title}`).join("\n");

  const response = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Topic: ${cluster.topic}\n\nHeadlines covering this cluster:\n${headlines}\n\nIs this a distinct, notable story worth a briefing card?`,
      },
    ],
    output_config: { format: zodOutputFormat(TriageResult) },
  });

  return response.parsed_output?.notable ?? false;
}
