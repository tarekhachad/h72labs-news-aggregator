import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Card } from "@/types";
import { generateWithRetryOnAmbiguousTruncation } from "@/lib/claudeText";

const client = new Anthropic();

const ExpandedReport = z.object({
  report: z.string(),
});

const SYSTEM_PROMPT = `You write the full expanded report for a news card the reader has chosen to open — they've already seen a short briefing-style summary and want more depth. Given the topic, the short summary already shown to them, and the source articles it was synthesized from, write a longer report (roughly 3-6 short paragraphs) that adds real detail and context the short summary didn't have room for: background, key figures/parties involved, what happens next, differing angles across sources if any. Don't just re-word the short summary at greater length — add substance. No headline, no bullet points, no preamble. Always write in English, even when the source articles are in another language.`;

function sourceTextFor(card: Pick<Card, "sources">): string {
  return card.sources
    .map((s) => `Source: ${s.source}\nTitle: ${s.title}\n${s.snippet}`)
    .join("\n\n");
}

async function generateReport(card: Pick<Card, "topic" | "shortSummary" | "sources">) {
  const response = await client.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    // Same reasoning as writeCard.ts: Sonnet 5's adaptive thinking would
    // otherwise eat into max_tokens on a bounded writing task that doesn't
    // need it.
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Topic: ${card.topic}\n\nShort summary already shown to the reader:\n${card.shortSummary}\n\nSource material:\n${sourceTextFor(card)}`,
      },
    ],
    output_config: { format: zodOutputFormat(ExpandedReport) },
  });

  return {
    text: response.parsed_output?.report ?? "",
    stopReason: response.stop_reason,
  };
}

/**
 * One Sonnet call, made lazily the first time a user expands a card (see
 * `POST /api/cards/[id]/expand`) — never pre-generated for every card, so
 * cost is only paid for reports someone actually reads. Reuses the same
 * source data already persisted on the card row (including snippet), not a
 * live cluster, since this can run long after the original digest was
 * generated.
 */
export async function generateExpandedReport(
  card: Pick<Card, "topic" | "shortSummary" | "sources">
): Promise<string> {
  const result = await generateWithRetryOnAmbiguousTruncation(
    () => generateReport(card),
    "generateExpandedReport"
  );
  return result.text;
}
