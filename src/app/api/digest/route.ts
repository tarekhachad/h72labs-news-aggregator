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

  const triaged = await Promise.all(
    clusters.map(async (cluster) => ({
      cluster,
      notable: await triageCluster(cluster),
    }))
  );

  const cards: Card[] = await Promise.all(
    triaged.filter((t) => t.notable).map((t) => writeCard(t.cluster))
  );

  return Response.json({ cards });
}
