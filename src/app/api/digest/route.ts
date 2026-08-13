import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { ingestArticles } from "@/lib/ingest";
import { clusterArticles } from "@/lib/cluster";
import { filterAlreadyCovered } from "@/lib/dedup";
import { triageCluster } from "@/lib/triage";
import { writeCard } from "@/lib/writeCard";
import { rankFrontPage } from "@/lib/rank";
import type { RankUpdate } from "@/lib/rankUpdates";
import {
  upsertDigestForToday,
  getLatestGeneratedAtForUser,
  saveGeneratedCards,
  claimDigestForGeneration,
  releaseDigestGeneration,
  getTodaysCardSummaries,
} from "@/lib/digests";
import type { Card, Source, Topic } from "@/types";
import { applyCardCap, MAX_CARDS_PER_TOPIC } from "@/lib/cardCap";
import { createUsageCollector, withUsageCollector } from "@/lib/usageCollector";
import type { UsageStage } from "@/lib/usage";

// The embedding model needs Node APIs (not available on the Edge runtime).
export const runtime = "nodejs";
// The pipeline makes several sequential Claude calls plus a local embedding
// pass — well past the platform's default function timeout.
export const maxDuration = 60;

// One line of this shape per pipeline stage, so the client can render real
// progress instead of a single opaque "loading" state. The final line
// carries the finished cards; a thrown error becomes an "error" line
// instead of a hard stream failure, since that's easier for the browser
// fetch API to consume mid-stream than an aborted response.
type DigestEvent =
  | { stage: "ingesting" }
  | { stage: "clustering"; articleCount: number }
  | { stage: "triaging"; clusterCount: number }
  | { stage: "writing"; notableCount: number }
  | { stage: "ranking" }
  // `topics` is the user's full selected topic list (not just the ones
  // that produced a card) — the client needs it to render one tab per
  // topic, including an explicit "nothing notable" state for topics that
  // genuinely had no notable news today, instead of those topics silently
  // vanishing from a flat merged list.
  | {
      stage: "done";
      cards: Card[];
      topics: Topic[];
      /**
       * Rank changes this run applied to cards the client is ALREADY
       * showing (today's earlier runs) — the same list persisted via
       * saveGeneratedCards below. Without it the client keeps every
       * already-rendered card's stale frontPageRank, so a card this run
       * dethroned still renders hero-sized next to the real new #1 until
       * a reload. Empty whenever ranking was skipped or failed open,
       * which the client must read as "change nothing", not "clear
       * everything".
       */
      rankUpdates: RankUpdate[];
    }
  | { stage: "error"; message: string };

async function* runDigestPipeline(
  supabase: SupabaseClient,
  digestId: string,
  profile: { topics: Topic[]; preferredSources: Source[] },
  sinceIso: string | null
): AsyncGenerator<DigestEvent> {
  // Cost accounting for this run. Scopes are entered around each awaited
  // stage below rather than once around this whole generator: context
  // propagation across a generator's yield/next suspension isn't something
  // to stake the instrumentation on, and the failure mode would be a silent
  // $0.00 — indistinguishable from a genuinely free run.
  const usage = createUsageCollector();
  // Filled in as each stage's size becomes known, so the summary can compare
  // calls made against work done. Declared out here because the finally
  // block needs whatever was known at the point of an early exit.
  //
  // Deliberately has no `dedup` entry: how many calls filterAlreadyCovered
  // makes depends on its internal embedding-similarity threshold, and
  // predicting it here would mean duplicating that logic — a second copy to
  // drift out of sync, producing false warnings about the very numbers this
  // is meant to make trustworthy. The trade is a narrow blind spot: a
  // regression that stopped dedup recording wouldn't trip a warning on a run
  // where other stages still billed. callSiteUsage.test.ts covers that
  // directly instead.
  const expectedCalls: Partial<Record<UsageStage, number>> = {};
  let reachedDone = false;

  // The whole body is wrapped so the generation claim (see claimDigestForGeneration
  // in the POST handler below) is always released on every exit path —
  // normal completion, a thrown error, or early cancellation (toNdjsonStream's
  // cancel() calls events.return?.(), which runs this finally block same as
  // any other early return from a generator).
  try {
    yield { stage: "ingesting" };
    const articles = await ingestArticles(profile.topics, profile.preferredSources, sinceIso);

    yield { stage: "clustering", articleCount: articles.length };
    const clusters = await clusterArticles(articles);

    // Today's already-persisted cards (empty on a first run, since nothing's
    // saved yet) — fetched once and reused by two independent consumers
    // below: cross-run dedup (topic/shortSummary only) and the front-page
    // ranking pass further down (also needs severity, and the id so a
    // re-ranked existing card's row can be updated). A failure here degrades
    // dedup gracefully (it just skips, same as its own empty-array early
    // return) but must NOT let ranking proceed on an incomplete view — see
    // existingCardsFetchFailed below, used to gate ranking specifically.
    let existingCards: Awaited<ReturnType<typeof getTodaysCardSummaries>> = [];
    let existingCardsFetchFailed = false;
    try {
      existingCards = await getTodaysCardSummaries(supabase, digestId);
    } catch (err) {
      existingCardsFetchFailed = true;
      console.error("[digest] failed to load today's existing cards, proceeding without them:", err);
    }

    // Cross-run duplicate check: on a second/third same-day run, a fresh
    // article about a story already covered earlier today (a follow-up, an
    // update, or just another outlet picking it up late) has a publishedAt
    // after the since-cursor and forms its own cluster — the ingest filter
    // only excludes stale articles, it has no notion of "already covered."
    // Skipped when there's nothing to compare against, which is the real
    // precondition here. This used to be expressed as `sinceIso !== null`,
    // a proxy that only coincided with it while the cursor reset every
    // midnight; now that the cursor carries across days (F.4.4), a new day's
    // first run has a non-null cursor and zero existing cards, and the proxy
    // would be wrong. filterAlreadyCovered no-ops on an empty list anyway —
    // this keeps that guarantee visible at the call site rather than
    // depending on the callee's internals.
    //
    // Best-effort, not required for success: unlike triageCluster/writeCard
    // (which fail closed per-cluster), a failure here (embedding error)
    // falls back to the un-deduplicated cluster list rather than failing the
    // whole run — occasionally showing a duplicate is a much smaller cost
    // than losing an entire digest generation over what's fundamentally a
    // quality-of-life check, not core pipeline logic.
    let survivingClusters = clusters;
    if (existingCards.length > 0) {
      try {
        survivingClusters = await withUsageCollector(usage, () =>
          filterAlreadyCovered(clusters, existingCards)
        );
      } catch (err) {
        console.error("[digest] cross-run dedup failed, proceeding without it:", err);
      }
    }

    yield { stage: "triaging", clusterCount: survivingClusters.length };
    // A single triage call failing (rate limit, network blip) shouldn't take
    // down the whole digest and discard every other cluster that already
    // succeeded — fail closed (treat as not notable) and keep going.
    expectedCalls.triage = survivingClusters.length;
    const triaged = await withUsageCollector(usage, () =>
      Promise.all(
        survivingClusters.map(async (cluster) => {
          try {
            const outcome = await triageCluster(cluster);
            return { cluster, notable: outcome.notable, severity: outcome.severity };
          } catch (err) {
            console.error(`[digest] triageCluster failed for ${cluster.topic}:`, err);
            return { cluster, notable: false, severity: 1 };
          }
        })
      )
    );
    // Capped BEFORE the writing event is yielded and before
    // expectedCalls.writeCard is set: the client renders "Writing N cards…"
    // straight off notableCount, and the cost summary compares calls made
    // against that same number — capping after either would make one of
    // them lie.
    const { kept: notableClusters, cuts } = applyCardCap(triaged.filter((t) => t.notable));
    for (const cut of cuts) {
      console.log(
        `[digest] ${cut.topic}: kept ${MAX_CARDS_PER_TOPIC} of ${cut.total} notable — dropped ${cut.dropped} at severity ${cut.severities.join(", ")}`
      );
    }

    yield { stage: "writing", notableCount: notableClusters.length };
    // One verbose cluster failing to write shouldn't take down the rest of
    // the digest — log it and drop that card instead of rejecting the batch.
    expectedCalls.writeCard = notableClusters.length;
    const written = await withUsageCollector(usage, () =>
      Promise.allSettled(notableClusters.map((nc) => writeCard(nc.cluster, nc.severity)))
    );

    // One canonical timestamp for the whole run — every card gets stamped
    // with this exact value (not each writeCard() call's own clock reading)
    // so cards from the same run are byte-identical on generatedAt, which
    // is what lets the feed pick out the latest run and badge its cards as
    // New, in both this live response and on every later reload.
    const generatedAt = new Date().toISOString();

    const cards: Card[] = [];
    for (const result of written) {
      if (result.status === "fulfilled") {
        cards.push({ ...result.value, generatedAt });
      } else {
        console.error("[digest] writeCard failed:", result.reason);
      }
    }

    // Secondary key on id: matches getDigestForDate's tiebreaker (see
    // digests.ts) so ties between cards sharing a publishedAt resolve the
    // same way in this live view as they will on every later reload. Plain
    // ordinal comparison, not localeCompare — Postgres compares uuid values
    // byte-by-byte, and localeCompare's locale-aware collation isn't
    // guaranteed to agree with that for every runtime/ICU configuration.
    cards.sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );

    yield { stage: "ranking" };
    // Cross-topic front-page ranking, re-run against the FULL cumulative
    // pool every run (today's already-persisted cards + this run's brand
    // new ones) — not just this run's new cards — so a bigger story landing
    // on a later same-day run can still dethrone an earlier run's top-6
    // pick. Deliberately NOT skipped when this run produces zero new cards
    // (an earlier version of this code tried that as a cost optimization,
    // but it created a real bug: a card left unranked by an earlier run's
    // rankFrontPage failure could never be reconsidered if every following
    // run happened to add no new cards — this run always gives it another
    // chance). What DOES gate ranking is existingCardsFetchFailed above:
    // ranking needs an accurate view of what's already ranked to avoid two
    // cards colliding on the same rank number, so a failed fetch means we
    // genuinely don't have that view and skip rather than guess. existingCards'
    // order is fixed before this run's cards, so indices
    // 0..existingCards.length-1 in the candidate pool below map to
    // existingCards, and the rest map 1:1 to `cards` (same array, same
    // order) — that alignment is what lets the results below be applied
    // back to the right row.
    let rankResult: (number | null)[] | null = null;
    if (!existingCardsFetchFailed) {
      const candidatePool = [
        ...existingCards.map((c) => ({ topic: c.topic, severity: c.severity, text: c.shortSummary })),
        ...cards.map((c) => ({ topic: c.topic, severity: c.severity, text: c.shortSummary })),
      ];
      // rankFrontPage short-circuits without calling Claude on an empty pool.
      expectedCalls.rank = candidatePool.length > 0 ? 1 : 0;
      try {
        rankResult = await withUsageCollector(usage, () => rankFrontPage(candidatePool));
      } catch (err) {
        // rankFrontPage already fails open internally (catches its own SDK
        // errors and returns null) — this second layer is defense-in-depth
        // against anything else going wrong building/awaiting the call itself.
        console.error("[digest] rankFrontPage threw unexpectedly, leaving today's front page unchanged:", err);
      }
    }

    // rankResult === null means ranking either didn't run at all (existing
    // cards couldn't be fetched, so ranking would be unsafe) or failed (the
    // fail-open case) — either way, every existing card's frontPageRank is
    // left exactly as it was (an empty update list, not a null-filled one),
    // and this run's new cards keep the frontPageRank: null that writeCard
    // already set them to. Only when ranking actually succeeded do we touch
    // anything, and then we touch EVERY candidate (including writing null
    // over a previously-ranked existing card that got bumped this run) —
    // not just the ones that changed, so demotions are handled correctly,
    // not just promotions.
    const existingCardRankUpdates: RankUpdate[] = [];
    if (rankResult !== null) {
      const ranks = rankResult;
      existingCards.forEach((existing, i) => {
        existingCardRankUpdates.push({ id: existing.id, frontPageRank: ranks[i] });
      });
      cards.forEach((card, i) => {
        card.frontPageRank = ranks[existingCards.length + i];
      });
    }

    // Persist before telling the client we're done — a persistence failure
    // becomes a thrown error here, caught by toNdjsonStream's try/catch below
    // and surfaced as a normal { stage: "error" } event, same as any other
    // pipeline failure. No partial-success path: the client never sees a
    // card it can't reliably bookmark or find again on reload. The
    // existing-card rank updates are folded into this same atomic call (see
    // saveGeneratedCards/persist_generated_cards) rather than a separate
    // best-effort RPC, closing a real rank-collision window a prior version
    // of this code had between two non-atomic writes.
    //
    // Note: the cursor advances to "now" even if some clusters above failed
    // triage/writing — a transiently-failed story's articles fall before the
    // next run's since-cutoff and won't be retried. Consciously accepted for
    // now (documented in ROADMAP.md's deferred section) rather than adding
    // per-cluster retry tracking; see that entry for the reasoning.
    await saveGeneratedCards(supabase, digestId, cards, generatedAt, existingCardRankUpdates);

    reachedDone = true;
    yield {
      stage: "done",
      cards,
      topics: profile.topics,
      rankUpdates: existingCardRankUpdates,
    };
  } finally {
    // Reported here, not after the `done` yield, so a run that errors or is
    // cancelled mid-flight still says what it spent — that's the case most
    // likely to surprise, since a cancelled run has already paid for triage.
    // A generator's finally runs at most once, so this is exactly one
    // summary per run. `report` swallows its own failures, so it can't stop
    // the generation claim below from being released and lock the user out
    // of generating again.
    usage.report({
      label: reachedDone ? "digest complete" : "digest ended early (error or cancelled)",
      expectedCalls,
    });
    await releaseDigestGeneration(supabase, digestId);
  }
}

function toNdjsonStream(events: AsyncGenerator<DigestEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
        // runDigestPipeline never actually yields a "error" stage today —
        // every failure propagates as a thrown exception, handled by the
        // catch block below instead (whose own throw path already runs the
        // generator's finally without needing events.return() here). This
        // branch is kept for defensive symmetry in case a future change
        // ever yields "error" directly.
        if (value.stage === "done" || value.stage === "error") {
          // The generator is still paused right at its final yield — it
          // won't run its own finally block (which releases the
          // generation-mutex claim) until resumed one more time. Force
          // that resumption now, the same way cancel() below already does
          // for early cancellation, instead of just closing the stream
          // and leaving the generator (and its cleanup) suspended forever.
          await events.return?.(undefined);
          controller.close();
        }
      } catch (err) {
        console.error("[digest] pipeline failed:", err);
        const message = err instanceof Error ? err.message : "Digest failed";
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ stage: "error", message }) + "\n"));
          controller.close();
        } catch {
          // Client already disconnected/canceled the stream — nothing left to tell it.
        }
      }
    },
    cancel() {
      // Best-effort: stops the pipeline from starting its next stage once
      // the client has gone away. A stage already in flight (e.g. a Claude
      // call mid-request) still runs to completion — this isn't a hard abort.
      events.return?.(undefined);
    },
  });
}

export async function POST() {
  const supabase = await createClient();
  // Network-verified — this is the one place that's actually
  // authorization-critical (gates real user data and real Claude spend),
  // unlike the proxy/middleware's cheaper getClaims() check. Never trusts
  // a client-supplied user ID; there isn't one in the request body.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const profile = await getUserProfile(supabase, user.id);
  // Gate on both topics and preferred sources — a profile with topics but
  // zero sources would otherwise pass this check and then silently
  // produce an empty digest (ingestArticles filters strictly by source).
  if (profile.topics.length === 0 || profile.preferredSources.length === 0) {
    // Defense-in-depth against a direct API hit that bypasses the
    // page-level redirect to /onboarding — shouldn't happen via the UI.
    return new Response("Onboarding incomplete", { status: 400 });
  }

  // The since-cursor is server-owned (digests.last_generated_at), not a
  // client-supplied value — this also makes "one digest per user per day,
  // appended to across multiple runs" an enforced fact instead of a client
  // convention (see upsertDigestForToday's unique (user_id, date) reliance).
  //
  // Two separate concerns, deliberately two calls: which row this run writes
  // into (always today's), and how far back this run reads (the user's last
  // successful generation, whatever day that was). Neither depends on the
  // other's result — the row upsertDigestForToday may create always has a
  // null last_generated_at, which the cursor query filters out — so they
  // issue concurrently rather than costing two serial round trips.
  const [{ digestId }, sinceCursor] = await Promise.all([
    upsertDigestForToday(supabase, user.id),
    getLatestGeneratedAtForUser(supabase, user.id),
  ]);

  // Mutual exclusion: without this, a double-click or two open tabs could
  // both reach this point with the same digestId/since-cursor and both
  // run the full pipeline, producing duplicate cards and doubling Claude
  // spend for the same window. Released in runDigestPipeline's finally
  // block once this run actually finishes (success, error, or cancellation).
  const claimed = await claimDigestForGeneration(supabase, digestId);
  if (!claimed) {
    return new Response(
      "A digest is already being generated for today — try again in a moment.",
      { status: 409 }
    );
  }

  return new Response(
    toNdjsonStream(runDigestPipeline(supabase, digestId, profile, sinceCursor)),
    { headers: { "Content-Type": "application/x-ndjson" } }
  );
}
