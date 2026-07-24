import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Card, Cluster } from "@/types";

const client = new Anthropic();

const CardSummary = z.object({
  shortSummary: z.string(),
});

const SYSTEM_PROMPT = `You write the short, always-visible summary for one card in a daily news briefing — the kind of briefing a head of state's staff would prepare. Given several source articles about the same story, write a single tight paragraph (2-4 sentences) capturing what happened and why it matters. Synthesize across sources; don't just paraphrase one. No headline, no bullet points, no preamble like "This story is about" — just the briefing text itself.`;

/**
 * One Sonnet call per triaged cluster — the only step that genuinely
 * needs a capable model, since turning multi-source text into clean
 * briefing prose is a real writing task.
 */
export async function writeCard(cluster: Cluster): Promise<Card> {
  const sourceText = cluster.articles
    .map((a) => `Source: ${a.source}\nTitle: ${a.title}\n${a.snippet}`)
    .join("\n\n");

  const response = await client.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Topic: ${cluster.topic}\n\n${sourceText}`,
      },
    ],
    output_config: { format: zodOutputFormat(CardSummary) },
  });

  return {
    topic: cluster.topic,
    shortSummary: response.parsed_output?.shortSummary ?? "",
    sources: cluster.articles.map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source,
    })),
  };
}
