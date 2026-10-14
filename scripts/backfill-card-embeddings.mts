/**
 * Fills the story timeline's columns on cards written before it existed:
 * `node --env-file=.env.admin --disable-warning=MODULE_TYPELESS_PACKAGE_JSON
 * scripts/backfill-card-embeddings.mts [--write]`.
 *
 * Every card with no embedding gets one from the local model (free: nothing
 * leaves this machine but the write), over its title and short summary, the
 * text the digest run embeds; every card with no story becomes a story of its
 * own. Without --write it only counts what it would fill.
 *
 * Batched, and idempotent: each update applies only while the field it fills
 * is still empty, so a re-run, or a card the new code saved meanwhile, is left
 * as it is.
 *
 * Needs the Supabase SECRET key, because `cards` accepts no writes from any
 * session; like invite.mts, it reads it from `.env.admin`, which only scripts
 * load.
 *
 * Runs on Node's own type stripping, outside the bundler, so it cannot import
 * src/lib/embeddings.ts or src/lib/storyTimeline.ts (both use the `@/` alias,
 * and the latter is server-only). It keeps its own copy of the embedding
 * settings and of storyText; a test holds both equal to the app's.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

/** Cards read and written per round. */
export const BATCH_SIZE = 100;
/** Updates in flight at once. */
const WRITE_CONCURRENCY = 8;
/** The model's own batch, as in embeddings.ts. */
const EMBED_BATCH_SIZE = 32;
const MAX_EMBED_CHARS = 2000;
const STORY_TEXT_CHARS = 1000;

/** The same text storyTimeline.ts embeds a new card from. */
export function storyText(title: string, shortSummary: string): string {
  const text = title.trim() === "" ? shortSummary.trim() : `${title.trim()}. ${shortSummary.trim()}`;
  return Array.from(text).slice(0, STORY_TEXT_CHARS).join("");
}

let embedder: Promise<FeatureExtractionPipeline> | null = null;

/** The local model, loaded as embeddings.ts loads it: vendored, never fetched. */
export async function embedLocally(texts: string[]): Promise<number[][]> {
  if (embedder === null) {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useFSCache = false;
    env.localModelPath = path.join(process.cwd(), "models");
    embedder = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  const model = await embedder;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE).map((t) => (t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t));
    const output = await model(batch, { pooling: "mean", normalize: true });
    const [rows, cols] = output.dims;
    const data = output.data as Float32Array;
    for (let r = 0; r < rows; r++) vectors.push(Array.from(data.slice(r * cols, (r + 1) * cols)));
  }
  return vectors;
}

export interface BackfillCounts {
  /** Cards with no embedding when the run started. */
  missingEmbedding: number;
  /** Cards with no story when the run started. */
  missingStory: number;
  /** Cards written (0 on a dry run). */
  updated: number;
  /** Cards another writer filled between this run's read and its update. */
  skipped: number;
  /** Cards whose update failed; a re-run picks them up. */
  failed: number;
}

interface Row {
  id: string;
  title: string | null;
  short_summary: string | null;
  embedding: unknown;
  story_id: string | null;
}

async function count(client: SupabaseClient, column: "embedding" | "story_id"): Promise<number> {
  const { count: n, error } = await client.from("cards").select("id", { count: "exact", head: true }).is(column, null);
  if (error) throw new Error(`counting cards with no ${column}: ${error.message}`);
  return n ?? 0;
}

/**
 * The backfill itself, with the client, the model and the output injected so
 * it can be tested without either. Pages by id, so a card whose update failed
 * is passed over rather than read again forever.
 */
export async function backfill(opts: {
  client: SupabaseClient;
  embed: (texts: string[]) => Promise<number[][]>;
  write: boolean;
  log?: (line: string) => void;
  batchSize?: number;
}): Promise<BackfillCounts> {
  const log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const counts: BackfillCounts = {
    missingEmbedding: await count(opts.client, "embedding"),
    missingStory: await count(opts.client, "story_id"),
    updated: 0,
    skipped: 0,
    failed: 0,
  };
  log(`${counts.missingEmbedding} card(s) have no embedding; ${counts.missingStory} have no story.`);
  if (!opts.write) {
    log("Dry run: nothing written. Run with --write to fill them.");
    return counts;
  }

  let after = "";
  for (;;) {
    let query = opts.client
      .from("cards")
      .select("id, title, short_summary, embedding, story_id")
      .or("embedding.is.null,story_id.is.null")
      .order("id", { ascending: true })
      .limit(batchSize);
    if (after !== "") query = query.gt("id", after);
    const { data, error } = await query;
    if (error) throw new Error(`reading cards: ${error.message}`);
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    const toEmbed = rows.filter((r) => r.embedding === null);
    const vectors = toEmbed.length === 0 ? [] : await opts.embed(toEmbed.map((r) => storyText(r.title ?? "", r.short_summary ?? "")));
    const vectorOf = new Map(toEmbed.map((r, i) => [r.id, vectors[i]]));

    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        const patch: { embedding?: number[]; story_id?: string } = {};
        const vector = vectorOf.get(row.id);
        if (vector !== undefined && vector.length === 384) patch.embedding = vector;
        if (row.story_id === null) patch.story_id = row.id;
        if (Object.keys(patch).length === 0) continue;

        let update = opts.client.from("cards").update(patch).eq("id", row.id);
        if (patch.embedding !== undefined) update = update.is("embedding", null);
        if (patch.story_id !== undefined) update = update.is("story_id", null);
        // Returns the rows it changed, so a card filled meanwhile counts as
        // skipped rather than updated.
        const { data: written, error: writeError } = await update.select("id");
        if (writeError) {
          counts.failed += 1;
          log(`card ${row.id}: ${writeError.message}`);
        } else if ((written ?? []).length > 0) {
          counts.updated += 1;
        } else {
          counts.skipped += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, rows.length) }, worker));
    log(`${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed so far.`);
    if (rows.length < batchSize) break;
  }

  log(`Done: ${counts.updated} card(s) updated, ${counts.skipped} skipped, ${counts.failed} failed.`);
  return counts;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !secretKey) {
    console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must both be set in .env.admin.");
    process.exitCode = 1;
    return;
  }
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--write");
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}. The only flag is --write.`);
    process.exitCode = 1;
    return;
  }
  const client = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const counts = await backfill({ client, embed: embedLocally, write: process.argv.includes("--write"), log: (line) => console.log(line) });
  if (counts.failed > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
