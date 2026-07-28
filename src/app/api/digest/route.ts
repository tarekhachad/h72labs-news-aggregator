import { devProfile } from "@/config/devProfile";
import { ingestArticles } from "@/lib/ingest";
import { clusterArticles } from "@/lib/cluster";
import { triageCluster } from "@/lib/triage";
import { writeCard } from "@/lib/writeCard";
import type { Card } from "@/types";

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
  | { stage: "done"; cards: Card[] }
  | { stage: "error"; message: string };

async function* runDigestPipeline(sinceIso: string | null): AsyncGenerator<DigestEvent> {
  yield { stage: "ingesting" };
  const articles = await ingestArticles(
    devProfile.topics,
    devProfile.preferredSources,
    sinceIso
  );

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

  const cards: Card[] = [];
  for (const result of written) {
    if (result.status === "fulfilled") {
      cards.push(result.value);
    } else {
      console.error("[digest] writeCard failed:", result.reason);
    }
  }

  cards.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  yield { stage: "done", cards };
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
        if (value.stage === "done" || value.stage === "error") {
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

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const since = body && typeof body.since === "string" ? body.since : null;

  return new Response(toNdjsonStream(runDigestPipeline(since)), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
