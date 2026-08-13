import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Card, Cluster } from "@/types";
import { generateWithRetryOnAmbiguousTruncation } from "@/lib/claudeText";
import { recordCall } from "@/lib/usageCollector";
import type { TrackedModel } from "@/lib/usage";

const client = new Anthropic();

// Exported so writeCard.test.ts can assert against the real schema
// directly (CardSummary.safeParse(...)) rather than only through the
// fully-mocked Anthropic client, which never actually exercises it — the
// regression this schema's shape guards against (a per-string
// `.trim().min(1)` throwing out of client.messages.parse() with no
// retry, see the comment in generateSummary() below) can only be proven
// closed by parsing against this exact object.
export const CardSummary = z.object({
  title: z.string(),
  shortSummary: z.string(),
  labels: z.array(z.string()).min(1).max(2),
});

const SYSTEM_PROMPT = `You write the content for one card in a daily news briefing — the kind of briefing a head of state's staff would prepare. Given several source articles about the same story, produce three fields:

- title: a short headline in Title Case (capitalize every major word; lowercase short articles/prepositions/conjunctions like "a," "the," "in," "of," "and" unless first or last word — e.g. "Fed Raises Rates to Curb Inflation") — 5-8 words, stay within this range, do not exceed 8 words; no ending punctuation. Name this specific story — more specific than the topic name alone, not a generic label.
- shortSummary: a single tight paragraph (2-4 sentences) capturing what happened and why it matters. Synthesize across sources; don't just paraphrase one. No headline, no bullet points, no preamble like "This story is about" — just the briefing text itself.
- labels: 1-2 short free-form tags (1-3 words each) for this story's specific angle — a company, organization, person, or subtopic a reader could use to scan at a glance. More specific than the topic name; not a repeat of it.

Always write everything in English, even when the source articles are in another language.`;

// Every other prompt builder in this app caps its per-article text —
// triage.ts slices snippets at 200 chars, dedup.ts has
// SNIPPET_CHARS_PER_ARTICLE, rank.ts has SUMMARY_CHARS_PER_CANDIDATE. This
// was the one that didn't, and the Final Phase's measurements showed it:
// writeCard input reached 5,142 tokens at the tail against a median of 871.
// Deliberately far more generous than the others — this is the step that
// actually writes the prose, so it needs the substance, not just enough
// text to recognize which story it's looking at.
const SOURCE_CHARS_PER_ARTICLE = 1200;

function sourceTextFor(cluster: Cluster): string {
  return cluster.articles
    .map(
      (a) =>
        `Source: ${a.source}\nTitle: ${a.title}\n${a.snippet.slice(0, SOURCE_CHARS_PER_ARTICLE)}`
    )
    .join("\n\n");
}

/**
 * Single-source clusters are written by Haiku, multi-source ones by Sonnet.
 *
 * This step's whole claim on a capable model is the prompt's own
 * instruction — "Synthesize across sources; don't just paraphrase one" —
 * and the Final Phase measured that ~89% of clusters are a single article,
 * where there is nothing to synthesize and the task is ordinary short-form
 * summarization of text already in the prompt. Sonnet is kept for exactly
 * the clusters the product claim is about.
 *
 * Judged on article count rather than anything subtler because that IS the
 * distinction: one source means one account of events.
 */
function modelForCluster(cluster: Cluster): TrackedModel {
  return cluster.articles.length === 1 ? "claude-haiku-4-5" : "claude-sonnet-5";
}

async function generateSummary(cluster: Cluster) {
  const model = modelForCluster(cluster);
  // Sonnet 5 runs adaptive thinking by default, and max_tokens caps
  // thinking + output combined — thinking was eating the budget and
  // truncating this short, bounded writing task. Not worth the cost or
  // latency here anyway. Sent only on the Sonnet path: Haiku 4.5 has no
  // adaptive thinking to turn off, and every other Haiku call site in this
  // app (triage, dedup, rank) passes no `thinking` at all. Undefined is
  // omitted from the serialized request rather than sent as null.
  const thinking = model === "claude-sonnet-5" ? ({ type: "disabled" } as const) : undefined;

  // Wrapped here rather than around writeCard() as a whole so that the
  // ambiguous-truncation retry in generateWithRetryOnAmbiguousTruncation
  // records BOTH attempts — that retry is the single most expensive event
  // in the pipeline, and counting only the winning one would under-report
  // exactly where it hurts most.
  const response = await recordCall("writeCard", model, () =>
    client.messages.parse({
      model,
      max_tokens: 2048,
      thinking,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Topic: ${cluster.topic}\n\n${sourceTextFor(cluster)}`,
        },
      ],
      output_config: { format: zodOutputFormat(CardSummary) },
    })
  );

  // Trimmed/filtered defensively here at the JS level, not via a zod
  // `.min(1)` constraint on the schema fed to zodOutputFormat — a schema
  // validation failure there throws out of client.messages.parse()
  // entirely, before generateWithRetryOnAmbiguousTruncation's retry-once
  // logic below ever gets a chance to run, hard-failing (and dropping)
  // the whole card over what's otherwise a recoverable anomaly (round-2
  // code review caught this: it's inconsistent with how every other
  // "content looks a little off" case in this file gets one retry before
  // giving up). A degenerate whitespace-only title/label is instead just
  // trimmed down to "" and handled the same way an entirely-missing one
  // already is: title's "" falls back to no title row (NewsCard.tsx/
  // FocusOverlay.tsx both already guard on `card.title &&`), and a
  // whitespace-only label is filtered out of the array rather than
  // rendering an empty chip.
  const labels = (response.parsed_output?.labels ?? [])
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return {
    // `text` is the field generateWithRetryOnAmbiguousTruncation's
    // completeness check runs against — deliberately shortSummary, not
    // title (unpunctuated by design, would never pass looksComplete()).
    text: response.parsed_output?.shortSummary ?? "",
    title: response.parsed_output?.title?.trim() ?? "",
    labels,
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
  const { text: shortSummary, title, labels } = await generateWithRetryOnAmbiguousTruncation(
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
    title,
    shortSummary,
    labels,
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
    // runs, which happens after writeCard in the pipeline.
    frontPageRank: null,
  };
}
