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

export async function POST() {
  const articles = await ingestArticles(devProfile.topics);
  const clusters = await clusterArticles(articles);

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

  // One verbose cluster failing to write shouldn't take down the rest of
  // the digest — log it and drop that card instead of rejecting the batch.
  const written = await Promise.allSettled(
    triaged.filter((t) => t.notable).map((t) => writeCard(t.cluster))
  );

  const cards: Card[] = [];
  for (const result of written) {
    if (result.status === "fulfilled") {
      cards.push(result.value);
    } else {
      console.error("[digest] writeCard failed:", result.reason);
    }
  }

  return Response.json({ cards });
}
