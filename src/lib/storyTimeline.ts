// Holds a module-scope Anthropic client, so this file must never reach a
// browser bundle.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { cosineSimilarity, embed } from "@/lib/embeddings";
import { MODELS, RefusalError, callModel, requestFor } from "@/lib/models";
import { bestEffortLog } from "@/lib/bestEffortLog";

/**
 * The story timeline: a card about a story the reader already saw on an
 * earlier day joins that story, so it can show "Day N" and list the earlier
 * days.
 *
 * Each new card is embedded with the local model, compared with the reader's
 * own cards from the 30 days before today, and, when any earlier story scores
 * above STORY_CANDIDATE_THRESHOLD, one Haiku call decides which (if any) of
 * the top three is the same ongoing story. The score never links anything on
 * its own: as in dedup.ts and mergeDuplicates.ts, two different matches by
 * one team score higher than a talks-then-deal pair.
 *
 * Fails open everywhere. A failed embedding, read, call or the time budget
 * running out leaves a card as a story of its own, and linkStories never
 * rejects, so the digest never fails because of the timeline.
 */

/** How far back a story is looked for: digests dated in the 30 days before today. */
export const STORY_LOOKBACK_DAYS = 30;

/**
 * The lowest similarity worth asking Haiku about.
 *
 * Measured with the local model on realistic card pairs (title plus short
 * summary): thirteen same-story pairs across days (talks open → deal agreed,
 * strike begins → strike ends, a no-confidence motion → the prime minister
 * resigns) score 0.542 to 0.812; twelve related-but-separate pairs score
 * 0.251 to 0.499, except two Real Madrid wins against different teams at
 * 0.777, which only Haiku can tell apart. A card makes at most one call
 * whatever this is, so a lower gate only spends calls the worst case already
 * pays for, and buys recall for follow-ups worded further apart than these.
 */
export const STORY_CANDIDATE_THRESHOLD = 0.45;

/** Earlier stories shown to Haiku per new card, best first. */
export const MAX_CANDIDATES_PER_CARD = 3;

/**
 * The most earlier cards one run compares against, newest first. Each row
 * carries 384 numbers (about 4.6 KB as JSON), so this bounds the read to a
 * few MB; a reader past it in 30 days compares against the newest ones.
 */
export const MAX_CANDIDATE_ROWS = 1000;

/**
 * The most Haiku calls one run makes: the card cap's own maximum (10 units ×
 * 8 cards on a first run), so the spend bound below holds even if that cap
 * ever loosens. A card past it is a story of its own.
 */
export const MAX_CHECKS_PER_RUN = 80;

/** Haiku calls in flight at once. */
export const CHECK_CONCURRENCY = 16;

/**
 * The whole stage's time, from the call to linkStories until the last answer
 * it waits for. It runs beside the front-page ranking call, which takes a
 * few seconds of its own, so it adds at most a few seconds to the run. A call
 * still out at the deadline is abandoned and its card stays a story of its
 * own.
 */
export const TIMELINE_BUDGET_MS = 8_000;

/** One call's own limit, inside the budget. */
const CALL_TIMEOUT_MS = 4_000;

/**
 * The answer is `{"match":N}`, under ten tokens. Low, because the spend bound
 * counts every call at this ceiling.
 */
const MAX_TOKENS = 32;

/**
 * What one card contributes to a prompt. Clipped so a call's size is bounded
 * whatever a card holds: the spend arithmetic in the lane report rests on it.
 */
const TITLE_CHARS = 120;
const SUMMARY_CHARS = 300;

/** The embedded text's own limit, well past any real title and short summary. */
const STORY_TEXT_CHARS = 1000;

// Its own client, as in mergeDuplicates.ts: no retries and a short timeout,
// so a slow call costs the run at most its slice of the budget.
const client = new Anthropic({ maxRetries: 0, timeout: CALL_TIMEOUT_MS });

const SYSTEM_PROMPT = `You link a reader's daily news cards into ongoing stories. You get one new card from today's brief and up to three cards from the reader's earlier briefs, numbered from 1, each with its date. Answer with the number of the earlier card that is the same ongoing real-world story as the new card, or 0 if none is.

Same story: one event or situation followed over days, even when the new card reports a follow-up, an update, a new development, a reaction or an outcome. Talks opening and a deal agreed in those talks are one story; a strike starting and the strike ending are one story; a storm forming and its landfall are one story.

Not the same story: related but separate events, such as two matches by one team, attacks on two different cities, two central banks' decisions, two companies' earnings, or two storms. Judge the underlying event, not the wording or the topic.

When in doubt, answer 0. A wrong link puts an unrelated story in the reader's timeline; a missed one only leaves the card without one.`;

const verdictSchema = z.object({ match: z.number().int() });

/**
 * The text a card is embedded from, here and in
 * scripts/backfill-card-embeddings.mts, which cannot import this file and
 * keeps its own copy; a test holds the two equal.
 */
export function storyText(title: string, shortSummary: string): string {
  const text = title.trim() === "" ? shortSummary.trim() : `${title.trim()}. ${shortSummary.trim()}`;
  return Array.from(text).slice(0, STORY_TEXT_CHARS).join("");
}

/** An earlier card a new one can join. */
export interface StoryCandidate {
  id: string;
  /** Null only on a card the backfill hasn't reached; it then lends its own id. */
  storyId: string | null;
  /** The card's digest date, YYYY-MM-DD. */
  date: string;
  title: string;
  shortSummary: string;
  embedding: number[];
}

/** What each new card is saved with. */
export interface StoryLink {
  /** Null when the card couldn't be embedded; the backfill can fill it later. */
  embedding: number[] | null;
  storyId: string;
}

export interface StoryLinkResult {
  /** One entry per new card, by card id. */
  links: Map<string, StoryLink>;
  /** Calls started, for the run's expected-call count. */
  haikuCalls: number;
  /** Cards that joined an earlier story. */
  linked: number;
}

/** The YYYY-MM-DD `days` before `date`, by calendar day (no clock, no zone). */
export function daysBefore(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

const EMBEDDING_LENGTH = 384;

function usableEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== EMBEDDING_LENGTH) return null;
  return value.every((x) => typeof x === "number" && Number.isFinite(x)) ? (value as number[]) : null;
}

/**
 * The reader's own cards from digests dated in the STORY_LOOKBACK_DAYS before
 * `today` (the run's digest date, in the reader's zone), newest first, that
 * have a usable embedding. Today's earlier runs are left out on purpose: a
 * same-day repeat is dedup.ts's to drop, not a timeline's to link. Throws on
 * a failed read; the caller fails open.
 */
export async function loadStoryCandidates(
  supabase: SupabaseClient,
  userId: string,
  today: string
): Promise<StoryCandidate[]> {
  const { data, error } = await supabase
    .from("cards")
    .select("id, story_id, title, short_summary, embedding, digests!inner(date, user_id)")
    .eq("digests.user_id", userId)
    .gte("digests.date", daysBefore(today, STORY_LOOKBACK_DAYS))
    .lt("digests.date", today)
    .not("embedding", "is", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(MAX_CANDIDATE_ROWS);
  if (error) throw new Error(`loadStoryCandidates: ${error.message}`);

  const candidates: StoryCandidate[] = [];
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const embedding = usableEmbedding(row.embedding);
    const digest = row.digests as { date?: unknown } | null;
    if (embedding === null || typeof row.id !== "string" || typeof digest?.date !== "string") continue;
    candidates.push({
      id: row.id,
      storyId: typeof row.story_id === "string" ? row.story_id : null,
      date: digest.date,
      title: typeof row.title === "string" ? row.title : "",
      shortSummary: typeof row.short_summary === "string" ? row.short_summary : "",
      embedding,
    });
  }
  return candidates;
}

/** Whitespace collapsed, clipped by code point so no surrogate pair is split. */
function clip(value: string, maxPoints: number): string {
  const points = Array.from(value.replace(/\s+/g, " ").trim());
  return points.length > maxPoints ? `${points.slice(0, maxPoints).join("")}…` : points.join("");
}

function cardLine(title: string, shortSummary: string): string {
  const t = clip(title, TITLE_CHARS);
  const s = clip(shortSummary, SUMMARY_CHARS);
  return t === "" ? s : `${t}. ${s}`;
}

export function buildParams(
  card: { title: string; shortSummary: string },
  today: string,
  earlier: readonly StoryCandidate[]
) {
  const list = earlier.map((c, i) => `${i + 1}. ${c.date}: ${cardLine(c.title, c.shortSummary)}`).join("\n");
  return requestFor(MODELS.timeline, {
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: `Earlier cards:\n${list}\n\nNew card (${today}): ${cardLine(card.title, card.shortSummary)}\n\nWhich earlier card, if any, is the same ongoing story as the new card? Answer its number, or 0.`,
      },
    ],
    output_config: { format: zodOutputFormat(verdictSchema) },
  });
}

/**
 * The best-scoring card of each earlier story at or above the threshold, best
 * story first, at most MAX_CANDIDATES_PER_CARD. One card per story, so three
 * days of one story don't fill all three places.
 */
export function topStories(vector: readonly number[], candidates: readonly StoryCandidate[]): StoryCandidate[] {
  const best = new Map<string, { candidate: StoryCandidate; score: number }>();
  for (const candidate of candidates) {
    const score = cosineSimilarity(vector as number[], candidate.embedding);
    if (!Number.isFinite(score) || score < STORY_CANDIDATE_THRESHOLD) continue;
    const story = candidate.storyId ?? candidate.id;
    const held = best.get(story);
    if (held === undefined || score > held.score) best.set(story, { candidate, score });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0))
    .slice(0, MAX_CANDIDATES_PER_CARD)
    .map((entry) => entry.candidate);
}

/**
 * Which of `earlier` Haiku called the same story, or null. Never throws; any
 * failure, a timeout, or an answer out of range is "no match". recordCall
 * still records the attempt, billed or not.
 */
async function askSameStory(
  params: ReturnType<typeof buildParams>,
  earlier: readonly StoryCandidate[],
  timeout: number,
  onError: (err: unknown) => void
): Promise<StoryCandidate | null> {
  try {
    const response = await callModel(client, "timeline", params, { timeout });
    const match = response.parsed_output?.match;
    if (typeof match !== "number" || !Number.isInteger(match) || match < 1 || match > earlier.length) return null;
    return earlier[match - 1];
  } catch (err) {
    // A refusal is logged on its own line, once, with its category. Counted
    // with the failures, only the run's first error would ever be printed.
    if (err instanceof RefusalError) {
      bestEffortLog("warn", `[timeline] ${err.message}; this card starts its own story`);
      return null;
    }
    onError(err);
    return null;
  }
}

/**
 * `value`, or `fallback` once the deadline passes or if it rejects. Lets the
 * stage's budget cover a read the caller started earlier.
 */
async function beforeDeadline<T>(value: T | Promise<T>, deadline: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value).catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gives each new card its embedding and its story: a matched earlier card's
 * story (a matched card with no story lends its own id), otherwise the card's
 * own id. `candidates` resolving to null (the earlier cards couldn't be read,
 * or not within the budget) makes every card start a story, still embedded
 * for tomorrow's run.
 *
 * Never rejects, and returns within TIMELINE_BUDGET_MS plus the local
 * embedding. Every card has an entry in `links` whatever fails.
 */
export async function linkStories(
  cards: readonly { id: string; title: string; shortSummary: string }[],
  today: string,
  candidatesSource: readonly StoryCandidate[] | null | Promise<readonly StoryCandidate[] | null>
): Promise<StoryLinkResult> {
  const startedAt = Date.now();
  const deadline = startedAt + TIMELINE_BUDGET_MS;
  const links = new Map<string, StoryLink>();
  for (const card of cards) links.set(card.id, { embedding: null, storyId: card.id });
  let haikuCalls = 0;
  let linked = 0;

  try {
    if (cards.length === 0) return { links, haikuCalls, linked };

    const [vectors, candidates] = await Promise.all([
      embed(cards.map((card) => storyText(card.title, card.shortSummary))).catch((err: unknown) => {
        bestEffortLog("error", "[timeline] embedding failed; every new card starts its own story:", err);
        return null;
      }),
      beforeDeadline(candidatesSource, deadline, null),
    ]);
    if (vectors === null) return { links, haikuCalls, linked };
    cards.forEach((card, i) => {
      const embedding = usableEmbedding(vectors[i]);
      links.set(card.id, { embedding, storyId: card.id });
    });
    if (candidates === null || candidates.length === 0) return { links, haikuCalls, linked };

    const checks = cards
      .map((card, i) => ({ card, vector: vectors[i] }))
      .filter((entry) => usableEmbedding(entry.vector) !== null)
      .map(({ card, vector }) => ({ card, earlier: topStories(vector, candidates) }))
      .filter((check) => check.earlier.length > 0);
    if (checks.length > MAX_CHECKS_PER_RUN) {
      bestEffortLog("warn", `[timeline] ${checks.length} cards have earlier stories; checking the first ${MAX_CHECKS_PER_RUN}`);
    }
    const queue = checks.slice(0, MAX_CHECKS_PER_RUN);

    let failures = 0;
    let firstError: unknown = null;
    const onError = (err: unknown) => {
      failures += 1;
      if (firstError === null) firstError = err;
    };

    // A worker never throws: one that did would reject Promise.all at once and
    // return from here while the other workers' calls were still out, after
    // the route had stopped waiting for them before it settles the run.
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const { card, earlier } = queue[next++];
        try {
          const params = buildParams(card, today, earlier);
          haikuCalls += 1;
          const match = await askSameStory(params, earlier, Math.min(CALL_TIMEOUT_MS, remaining), onError);
          if (match !== null) {
            links.set(card.id, { embedding: links.get(card.id)?.embedding ?? null, storyId: match.storyId ?? match.id });
            linked += 1;
          }
        } catch (err) {
          onError(err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, worker));

    if (failures > 0) {
      bestEffortLog("error", `[timeline] ${failures} story check(s) failed; those cards start their own story. First error:`, firstError);
    }
    bestEffortLog(
      "log",
      `[timeline] ${cards.length} new card(s), ${candidates.length} earlier, ${haikuCalls} checked of ${queue.length}, ${linked} linked (${Date.now() - startedAt} ms)`
    );
    return { links, haikuCalls, linked };
  } catch (err) {
    bestEffortLog("error", "[timeline] failed; the remaining new cards start their own story:", err);
    return { links, haikuCalls, linked };
  }
}
