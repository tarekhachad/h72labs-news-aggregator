import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { ingestArticles } from "@/lib/ingest";
import { clusterArticles } from "@/lib/cluster";
import { triageCluster } from "@/lib/triage";
import { writeCard } from "@/lib/writeCard";
import {
  upsertDigestForToday,
  saveGeneratedCards,
  claimDigestForGeneration,
  releaseDigestGeneration,
} from "@/lib/digests";
import type { Card, Source, Topic } from "@/types";

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
  // `topics` is the user's full selected topic list (not just the ones
  // that produced a card) — the client needs it to render one tab per
  // topic, including an explicit "nothing notable" state for topics that
  // genuinely had no notable news today, instead of those topics silently
  // vanishing from a flat merged list.
  | { stage: "done"; cards: Card[]; topics: Topic[] }
  | { stage: "error"; message: string };

async function* runDigestPipeline(
  supabase: SupabaseClient,
  digestId: string,
  profile: { topics: Topic[]; preferredSources: Source[] },
  sinceIso: string | null
): AsyncGenerator<DigestEvent> {
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

    yield { stage: "triaging", clusterCount: clusters.length };
    // A single triage call failing (rate limit, network blip) shouldn't take
    // down the whole digest and discard every other cluster that already
    // succeeded — fail closed (treat as not notable) and keep going.
    const triaged = await Promise.all(
      clusters.map(async (cluster) => {
        try {
          return { cluster, notable: await triageCluster(cluster) };
        } catch (err) {
          console.error(`[digest] triageCluster failed for ${cluster.topic}:`, err);
          return { cluster, notable: false };
        }
      })
    );
    const notableClusters = triaged.filter((t) => t.notable).map((t) => t.cluster);

    yield { stage: "writing", notableCount: notableClusters.length };
    // One verbose cluster failing to write shouldn't take down the rest of
    // the digest — log it and drop that card instead of rejecting the batch.
    const written = await Promise.allSettled(notableClusters.map(writeCard));

    // One canonical timestamp for the whole run — every card gets stamped
    // with this exact value (not each writeCard() call's own clock reading)
    // so cards from the same run are byte-identical on generatedAt, which is
    // what lets the feed detect run boundaries and draw a divider between
    // them, in both this live response and on every later reload.
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

    // Persist before telling the client we're done — a persistence failure
    // becomes a thrown error here, caught by toNdjsonStream's try/catch below
    // and surfaced as a normal { stage: "error" } event, same as any other
    // pipeline failure. No partial-success path: the client never sees a
    // card it can't reliably bookmark or find again on reload.
    //
    // Note: the cursor advances to "now" even if some clusters above failed
    // triage/writing — a transiently-failed story's articles fall before the
    // next run's since-cutoff and won't be retried. Consciously accepted for
    // now (documented in ROADMAP.md's deferred section) rather than adding
    // per-cluster retry tracking; see that entry for the reasoning.
    await saveGeneratedCards(supabase, digestId, cards, generatedAt);

    yield { stage: "done", cards, topics: profile.topics };
  } finally {
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

  // The since-cursor is now server-owned (digests.last_generated_at), not a
  // client-supplied value — this also makes "one digest per user per day,
  // appended to across multiple runs" an enforced fact instead of a client
  // convention (see upsertDigestForToday's unique (user_id, date) reliance).
  const { digestId, lastGeneratedAt } = await upsertDigestForToday(supabase, user.id);

  // Mutual exclusion: without this, a double-click or two open tabs could
  // both reach this point with the same digestId/lastGeneratedAt and both
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
    toNdjsonStream(runDigestPipeline(supabase, digestId, profile, lastGeneratedAt)),
    { headers: { "Content-Type": "application/x-ndjson" } }
  );
}
