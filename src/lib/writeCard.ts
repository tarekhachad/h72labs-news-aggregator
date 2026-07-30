import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Card, Cluster } from "@/types";

const client = new Anthropic();

const CardSummary = z.object({
  shortSummary: z.string(),
});

const SYSTEM_PROMPT = `You write the short, always-visible summary for one card in a daily news briefing — the kind of briefing a head of state's staff would prepare. Given several source articles about the same story, write a single tight paragraph (2-4 sentences) capturing what happened and why it matters. Synthesize across sources; don't just paraphrase one. No headline, no bullet points, no preamble like "This story is about" — just the briefing text itself. Always write the summary in English, even when the source articles are in another language.`;

async function generateSummary(
  cluster: Cluster
): Promise<{ shortSummary: string; stop_reason: string | null }> {
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

  return {
    shortSummary: response.parsed_output?.shortSummary ?? "",
    stop_reason: response.stop_reason,
  };
}

function looksComplete(summary: string): boolean {
  return /[.!?]["')\]]?$/.test(summary.trim());
}

/**
 * One Sonnet call per triaged cluster — the only step that genuinely needs
 * a capable model, since turning multi-source text into clean briefing
 * prose is a real writing task. A second call only happens on the rare
 * ambiguous-completion retry below, not on the normal path.
 */
export async function writeCard(cluster: Cluster): Promise<Card> {
  const initial = await generateSummary(cluster);
  let shortSummary = initial.shortSummary;
  const stop_reason = initial.stop_reason;

  // Empty output has no real content regardless of why (a refusal, or a
  // parse failure that left parsed_output undefined) — nothing to salvage,
  // always drop. The caller (the digest route) already treats a thrown
  // writeCard as a droppable failure, not a fatal one.
  if (shortSummary.trim().length === 0) {
    throw new Error(`writeCard produced an empty summary (stop_reason: ${stop_reason})`);
  }

  if (!looksComplete(shortSummary)) {
    if (stop_reason !== "end_turn") {
      // A confirmed-bad completion (genuine max_tokens cutoff, a refusal,
      // or anything unexpected) — retrying wouldn't change that this
      // specific response is already a known-bad signal, so drop directly.
      throw new Error(
        `writeCard produced a truncated summary (stop_reason: ${stop_reason}): "${shortSummary}"`
      );
    }

    // Genuinely ambiguous: the model believes it finished normally, but the
    // text doesn't look complete. stop_reason "end_turn" alone can't tell a
    // one-off bad generation from content that's actually fine — retrying
    // is cheap relative to either showing broken text or discarding an
    // otherwise-good story, so get a fresh attempt before giving up.
    console.warn(
      `[writeCard] summary looked incomplete (stop_reason: end_turn) — retrying once: "${shortSummary.slice(0, 200)}${shortSummary.length > 200 ? "…" : ""}"`
    );
    const retry = await generateSummary(cluster);
    if (retry.shortSummary.trim().length === 0 || !looksComplete(retry.shortSummary)) {
      throw new Error(
        `writeCard produced an incomplete summary even after retry (stop_reason: ${retry.stop_reason}): "${retry.shortSummary}"`
      );
    }
    shortSummary = retry.shortSummary;
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
