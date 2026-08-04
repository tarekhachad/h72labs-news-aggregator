import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Card, Cluster } from "@/types";
import { generateWithRetryOnAmbiguousTruncation } from "@/lib/claudeText";

const client = new Anthropic();

const CardSummary = z.object({
  shortSummary: z.string(),
});

const SYSTEM_PROMPT = `You write the short, always-visible summary for one card in a daily news briefing — the kind of briefing a head of state's staff would prepare. Given several source articles about the same story, write a single tight paragraph (2-4 sentences) capturing what happened and why it matters. Synthesize across sources; don't just paraphrase one. No headline, no bullet points, no preamble like "This story is about" — just the briefing text itself. Always write the summary in English, even when the source articles are in another language.`;

function sourceTextFor(cluster: Cluster): string {
  return cluster.articles
    .map((a) => `Source: ${a.source}\nTitle: ${a.title}\n${a.snippet}`)
    .join("\n\n");
}

async function generateSummary(cluster: Cluster) {
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
        content: `Topic: ${cluster.topic}\n\n${sourceTextFor(cluster)}`,
      },
    ],
    output_config: { format: zodOutputFormat(CardSummary) },
  });

  return {
    text: response.parsed_output?.shortSummary ?? "",
    stopReason: response.stop_reason,
  };
}

/**
 * One Sonnet call per triaged cluster — the only step that genuinely needs
 * a capable model, since turning multi-source text into clean briefing
 * prose is a real writing task. A second call only happens on the rare
 * ambiguous-completion retry inside generateWithRetryOnAmbiguousTruncation,
 * not on the normal path.
 */
export async function writeCard(cluster: Cluster, severity: number): Promise<Card> {
  const shortSummary = await generateWithRetryOnAmbiguousTruncation(
    () => generateSummary(cluster),
    "writeCard"
  );

  // Freshest coverage across the cluster's sources — what a reader means by
  // "how new is this," not an average of unrelated outlets' publish times.
  // Articles' publishedAt isn't guaranteed to be ISO (RSS pubDate can be
  // RFC 822), so compare parsed timestamps rather than raw strings.
  const publishedAt = cluster.articles.reduce(
    (latest, a) => (new Date(a.publishedAt) > new Date(latest.publishedAt) ? a : latest),
    cluster.articles[0]
  ).publishedAt;

  return {
    id: crypto.randomUUID(),
    topic: cluster.topic,
    shortSummary,
    expandedReport: null,
    sources: cluster.articles.map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source,
      snippet: a.snippet,
    })),
    publishedAt,
    // Placeholder — the digest route overwrites this on every card with the
    // one canonical timestamp for the whole run before persisting/returning
    // it, the same way it doesn't trust each parallel writeCard() call's own
    // clock reading for anything run-identifying.
    generatedAt: new Date().toISOString(),
    bookmarked: false,
    // Known at call time (triage already graded this cluster before
    // writeCard runs), so it's a real parameter copied straight through —
    // unlike generatedAt above, this isn't a placeholder to be overwritten.
    severity,
    // Genuine placeholder: unknown until rank.ts's cross-topic ranking pass
    // runs (not yet built), which happens after writeCard in the pipeline.
    frontPageRank: null,
  };
}
