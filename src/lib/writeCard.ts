// Holds a module-scope Anthropic client, so this file must never reach a
// browser bundle. Importing it from a client component is now a build error
// rather than a silent key leak.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Article, Card, Cluster, Source } from "@/types";
import { generateWithRetryOnAmbiguousTruncation, QUOTATION_STYLE } from "@/lib/claudeText";
import { boundOf, recordCall } from "@/lib/usageCollector";
import { modelForCluster } from "@/lib/cardModel";
import { orderPreferredFirst, type PreferredSources } from "@/lib/preferredSources";
import { signSourceLink, sourceLinkSecret } from "@/lib/sourceLinks";
import {
  extractForStory,
  FULL_TEXT_INSTRUCTION,
  splitByFullText,
  type ExtractResult,
} from "@/lib/extract";

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

Always write everything in English, even when the source articles are in another language.

${QUOTATION_STYLE}`;

// Every other prompt builder in this app caps its per-article text —
// triage.ts slices snippets at 200 chars, dedup.ts has
// SNIPPET_CHARS_PER_ARTICLE, rank.ts has SUMMARY_CHARS_PER_CANDIDATE. This
// was the one that didn't, and the Final Phase's measurements showed it:
// writeCard input reached 5,142 tokens at the tail against a median of 871.
// Deliberately far more generous than the others — this is the step that
// actually writes the prose, so it needs the substance, not just enough
// text to recognize which story it's looking at.
const SOURCE_CHARS_PER_ARTICLE = 1200;

/**
 * How long a card waits for its articles' pages, measured from the start of
 * its writeCard call. The digest starts every card at once, so this is also
 * about the most extraction adds to a whole run.
 */
const EXTRACT_BUDGET_MS = 15_000;

function sourceTextFor(articles: readonly Article[]): string {
  return articles
    .map(
      (a) =>
        `Source: ${a.source}\nTitle: ${a.title}\n${a.snippet.slice(0, SOURCE_CHARS_PER_ARTICLE)}`
    )
    .join("\n\n");
}

/**
 * One sentence telling the writer whose reporting leads, or null when the
 * cluster has no preferred outlet (the prompt is then exactly as without
 * preferences). Names only the outlets actually present, in the order their
 * articles are listed.
 */
export function preferredLeadNote(cluster: Cluster, preferred: PreferredSources): string | null {
  if (!preferred || preferred.length === 0) return null;
  const picked = new Set<Source>(preferred);
  const present = [...new Set(cluster.articles.map((a) => a.source).filter((s) => picked.has(s)))];
  if (present.length === 0) return null;
  return `The reader's preferred sources for this story are listed first (${present.join(", ")}): lead with their reporting and use the other sources to fill gaps.`;
}

/**
 * The user message sent to the writer for an already-ordered cluster. A
 * Countries cluster names its country ("Countries: Uganda"), so the writer
 * knows which country's story it is telling. Exported for tests.
 *
 * `extracted[i]` is the extraction result for `cluster.articles[i]`. With no
 * full text at all the message is exactly the snippet-only one. With some,
 * the full-text articles come first and are the material (preferred outlets
 * leading among them, and the lead note naming only those), then every other
 * source as headline-and-snippet context.
 */
export function buildWriteCardContent(
  cluster: Cluster,
  preferred?: PreferredSources,
  extracted: readonly (ExtractResult | undefined)[] = []
): string {
  const topic = cluster.subtopic ? `${cluster.topic}: ${cluster.subtopic}` : cluster.topic;
  const { fullText, headlineOnly } = splitByFullText(cluster.articles, extracted);

  if (fullText.length === 0) {
    const note = preferredLeadNote(cluster, preferred);
    return `Topic: ${topic}\n\n${note === null ? "" : `${note}\n\n`}${sourceTextFor(cluster.articles)}`;
  }

  const note = preferredLeadNote({ ...cluster, articles: fullText.map((f) => f.item) }, preferred);
  const material = fullText
    .map(({ item, text }) => `Source: ${item.source}\nTitle: ${item.title}\nText: ${text}`)
    .join("\n\n");
  const context =
    headlineOnly.length === 0
      ? ""
      : `\n\nOther coverage (headline and feed summary only):\n\n${sourceTextFor(headlineOnly)}`;
  return `Topic: ${topic}\n\n${FULL_TEXT_INSTRUCTION}\n\n${note === null ? "" : `${note}\n\n`}Full-text articles:\n\n${material}${context}`;
}

async function generateSummary(
  cluster: Cluster,
  preferred: PreferredSources,
  extracted: readonly (ExtractResult | undefined)[]
) {
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
  const params = {
    model,
    max_tokens: 2048,
    thinking,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildWriteCardContent(cluster, preferred, extracted),
      },
    ],
    output_config: { format: zodOutputFormat(CardSummary) },
  } satisfies Parameters<typeof client.messages.parse>[0];
  const response = await recordCall("writeCard", model, () => client.messages.parse(params), boundOf(params, client.maxRetries + 1));

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
 * The card's source list as persisted. Each link carries the server's
 * signature, so the full report can tell it from one a user stored by hand;
 * with no secret configured, links are stored unsigned and never fetched.
 */
function signedSources(articles: Cluster["articles"]): Card["sources"] {
  const secret = sourceLinkSecret();
  return articles.map((a) => ({
    title: a.title,
    url: a.url,
    source: a.source,
    snippet: a.snippet,
    ...(secret === null ? {} : { sig: signSourceLink(a.url, secret) }),
  }));
}

/**
 * Thrown by writeCard for a cluster with no articles, before any call is
 * made. The route records it as a card failure like any other rejection;
 * the name is what identifies it there.
 */
export class EmptyClusterError extends Error {
  constructor(topic: string) {
    super(`writeCard: cluster for "${topic}" has no articles`);
    this.name = "EmptyClusterError";
  }
}

/**
 * One Claude call per triaged cluster, on the model `modelForCluster` picks:
 * Haiku for a single-article cluster, Sonnet for a multi-source one. A second
 * call only happens on the rare ambiguous-completion retry inside
 * generateWithRetryOnAmbiguousTruncation, not on the normal path.
 *
 * Do not describe this stage as "one Sonnet call per cluster": most clusters
 * are single-article and go to Haiku, so the stage routinely mixes both models.
 * Nor is card writing the pipeline's dominant cost — triage is.
 *
 * The reader's preferred outlets lead: their articles go first in the
 * prompt, with a sentence asking the writer to lead with them, and first in
 * `Card.sources`, which is the order the card shows and the order the full
 * report later reads (generateExpandedReport works from the persisted list).
 * Optional; with none, or none in this cluster, prompt and order are exactly
 * the cluster's own.
 *
 * Before writing, it fetches its articles' pages, top of the list first
 * (extractForStory in extract.ts) and writes from whatever full text arrived within
 * EXTRACT_BUDGET_MS. That text only reaches the prompt: `Card.sources` keeps
 * every source, in the same order, with its RSS snippet.
 */
export async function writeCard(
  cluster: Cluster,
  severity: number,
  preferredSources?: PreferredSources
): Promise<Card> {
  // Checked before the call, not after: a card needs at least one source, so
  // an empty cluster can only fail, and failing here means it is never paid
  // for. Clustering never produces one; this is defence, and costs one length
  // check on the normal path.
  if (cluster.articles.length === 0) {
    throw new EmptyClusterError(cluster.topic);
  }

  const deadline = Date.now() + EXTRACT_BUDGET_MS;
  const ordered: Cluster = {
    ...cluster,
    articles: orderPreferredFirst(cluster.articles, preferredSources),
  };

  // Fetched once, outside the retry: a second writing attempt reuses the
  // same text. Never rejects; a page that fails is simply not full text.
  const extracted = await extractForStory(
    ordered.articles.map((a) => a.url),
    { deadline, label: "writeCard" }
  );

  const { text: shortSummary, title, labels } = await generateWithRetryOnAmbiguousTruncation(
    () => generateSummary(ordered, preferredSources, extracted),
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
    sources: signedSources(ordered.articles),
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
    // What the Countries page filters on; null for every other topic. `||`
    // so an empty string is stored as none, the unit triage, the cap and
    // dedup already judged it as.
    subtopic: cluster.subtopic || null,
  };
}
