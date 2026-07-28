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
    max_tokens: 2048,
    // Sonnet 5 runs adaptive thinking by default, and max_tokens caps
    // thinking + output combined — thinking was eating the budget and
    // truncating this short, bounded writing task. Not worth the cost
    // or latency here anyway.
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Topic: ${cluster.topic}\n\n${sourceText}`,
      },
    ],
    output_config: { format: zodOutputFormat(CardSummary) },
  });

  const shortSummary = response.parsed_output?.shortSummary ?? "";

  // A summary that doesn't end on sentence-terminal punctuation is a cut-off
  // response (e.g. still hit a token limit despite the headroom above) —
  // better to drop the card than ship a card that trails off mid-sentence.
  // The caller (the digest route) already treats a thrown writeCard as a
  // droppable failure, not a fatal one.
  if (!/[.!?]["')\]]?$/.test(shortSummary.trim())) {
    throw new Error(`writeCard produced a truncated summary: "${shortSummary}"`);
  }

  // Freshest coverage across the cluster's sources — what a reader means by
  // "how new is this," not an average of unrelated outlets' publish times.
  // Articles' publishedAt isn't guaranteed to be ISO (RSS pubDate can be
  // RFC 822), so compare parsed timestamps rather than raw strings.
  const publishedAt = cluster.articles.reduce(
    (latest, a) => (new Date(a.publishedAt) > new Date(latest.publishedAt) ? a : latest),
    cluster.articles[0]
  ).publishedAt;

  return {
    topic: cluster.topic,
    shortSummary,
    sources: cluster.articles.map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source,
    })),
    publishedAt,
  };
}
