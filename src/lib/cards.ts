// Holds a module-scope Anthropic client, so this file must never reach a
// browser bundle. Importing it from a client component is now a build error
// rather than a silent key leak.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Card } from "@/types";
import { generateWithRetryOnAmbiguousTruncation, QUOTATION_STYLE } from "@/lib/claudeText";
import { boundOf, recordCall } from "@/lib/usageCollector";
import { sourceLinkSecret, verifySourceLink } from "@/lib/sourceLinks";
import {
  extractForStory,
  FULL_TEXT_INSTRUCTION,
  splitByFullText,
  type ExtractResult,
} from "@/lib/extract";

const client = new Anthropic();

const ExpandedReport = z.object({
  report: z.string(),
});

const SYSTEM_PROMPT = `You write the full expanded report for a news card the reader has chosen to open — they've already seen a short briefing-style summary and want more depth. Given the topic, the short summary already shown to them, and the source articles it was synthesized from, write a longer report (roughly 3-6 short paragraphs) that adds real detail and context the short summary didn't have room for: background, key figures/parties involved, what happens next, differing angles across sources if any. Don't just re-word the short summary at greater length — add substance. No headline, no bullet points, no preamble. Always write in English, even when the source articles are in another language.

${QUOTATION_STYLE}`;

/**
 * How long the report waits for the sources' pages. A reader is watching a
 * spinner, and the report call itself takes far longer, so this stays well
 * under the card writer's budget; a page that loads at all usually does in
 * under a second.
 */
const EXTRACT_BUDGET_MS = 8_000;

type CardSource = Card["sources"][number];

function sourceTextFor(sources: readonly CardSource[]): string {
  return sources
    .map((s) => `Source: ${s.source}\nTitle: ${s.title}\n${s.snippet}`)
    .join("\n\n");
}

/**
 * The same split as the card writer: full-text sources first as the material,
 * the rest as headline-and-snippet context. With no full text it is exactly
 * the snippet-only source list.
 */
function sourceMaterialFor(
  sources: readonly CardSource[],
  extracted: readonly (ExtractResult | undefined)[]
): string {
  const { fullText, headlineOnly } = splitByFullText(sources, extracted);
  if (fullText.length === 0) return sourceTextFor(sources);
  const material = fullText
    .map(({ item, text }) => `Source: ${item.source}\nTitle: ${item.title}\nText: ${text}`)
    .join("\n\n");
  const context =
    headlineOnly.length === 0
      ? ""
      : `\n\nOther coverage (headline and feed summary only):\n\n${sourceTextFor(headlineOnly)}`;
  return `${FULL_TEXT_INSTRUCTION}\n\nFull-text articles:\n\n${material}${context}`;
}

async function generateReport(
  card: Pick<Card, "topic" | "shortSummary" | "sources">,
  extracted: readonly (ExtractResult | undefined)[]
) {
  // Inside generateReport, not around generateExpandedReport, so the
  // ambiguous-truncation retry records both attempts — see writeCard.ts.
  const params = {
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
        content: `Topic: ${card.topic}\n\nShort summary already shown to the reader:\n${card.shortSummary}\n\nSource material:\n${sourceMaterialFor(card.sources, extracted)}`,
      },
    ],
    output_config: { format: zodOutputFormat(ExpandedReport) },
  } satisfies Parameters<typeof client.messages.parse>[0];
  const response = await recordCall("expand", "claude-sonnet-5", () => client.messages.parse(params), boundOf(params, client.maxRetries + 1));

  return {
    text: response.parsed_output?.report ?? "",
    stopReason: response.stop_reason,
  };
}

/**
 * Fetches only the sources whose link carries a valid server signature, and
 * returns results aligned to `sources` (undefined where nothing was fetched,
 * which the report treats as headline-only). The card's `sources` come from
 * the database, where a signed-in user can store any link, so an unsigned or
 * forged link is never requested.
 */
async function extractSignedSources(
  sources: Card["sources"],
  deadline: number
): Promise<(ExtractResult | undefined)[]> {
  const secret = sourceLinkSecret();
  const fetchable =
    secret === null ? [] : sources.flatMap((s, i) => (verifySourceLink(s.url, s.sig, secret) ? [i] : []));
  const results: (ExtractResult | undefined)[] = sources.map(() => undefined);
  if (fetchable.length === 0) return results;
  const fetched = await extractForStory(
    fetchable.map((i) => sources[i].url),
    { deadline, label: "expand" }
  );
  fetched.forEach((r, k) => {
    results[fetchable[k]] = r;
  });
  return results;
}

/**
 * One Sonnet call, made lazily the first time a user expands a card (see
 * `POST /api/cards/[id]/expand`) — never pre-generated for every card, so
 * cost is only paid for reports someone actually reads. Reuses the same
 * source data already persisted on the card row (including snippet), not a
 * live cluster, since this can run long after the original digest was
 * generated.
 *
 * The pages are fetched again rather than kept from the card's own run, since
 * extracted text is never stored. A page that fails now (blocked since, or
 * gone) falls back to the persisted snippet.
 */
export async function generateExpandedReport(
  card: Pick<Card, "topic" | "shortSummary" | "sources">
): Promise<string> {
  const deadline = Date.now() + EXTRACT_BUDGET_MS;
  const extracted = await extractSignedSources(card.sources, deadline);
  const result = await generateWithRetryOnAmbiguousTruncation(
    () => generateReport(card, extracted),
    "generateExpandedReport"
  );
  return result.text;
}
