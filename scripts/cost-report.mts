/**
 * Generates the cost report from the local run log.
 *
 * I/O only. Every number, every judgement about what counts as a sample, and
 * both renderings live in `src/lib/costReport.ts`, which is pure and tested.
 * This file reads a file, calls three functions, and writes two files — if it
 * ever starts computing something, that belongs in the library instead.
 *
 * `.mts`, not `.ts`: Node needs to know this is an ES module, and the two
 * ways to say so are a file extension or `"type": "module"` in package.json.
 * The latter would change how Next resolves every other file in the project
 * to fix one script, so the extension wins. `tsconfig.json`'s include list
 * already covers the `.mts` extension, so this is type-checked exactly like
 * the rest of the codebase. (Naming that glob literally here would end this
 * block comment early — its `*` and `/` close the comment.)
 *
 * Reads the LOCAL JSONL rather than Supabase on purpose. There is no
 * service-role key in this project, so a script could only reach Supabase
 * through an interactive sign-in — which would make generating a document
 * depend on credentials and a network. Both sinks serialise the same record,
 * so a future `--source=supabase` would swap the reader, not the renderer.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCostReport,
  parseUsageRunLines,
  renderCostHtml,
  renderCostMarkdown,
} from "../src/lib/costReport.ts";

const COST_DIR = join(process.cwd(), "notes-logs", "cost");
const RUNS_JSONL = join(COST_DIR, "runs.jsonl");
const MARKDOWN_OUT = join(COST_DIR, "(C) COST.md");
const HTML_OUT = join(COST_DIR, "report.html");

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(RUNS_JSONL, "utf8");
  } catch {
    // Named explicitly, because the most likely cause is not a missing step
    // but a misunderstanding: records are written in DEVELOPMENT only, so a
    // log that never appears after a production run is working as designed.
    console.error(`No run log at ${RUNS_JSONL}.`);
    console.error("Generate a digest under `npm run dev` first — runs are recorded to disk in development only.");
    process.exitCode = 1;
    return;
  }

  const { records, skipped } = parseUsageRunLines(raw.split("\n"));
  // `skipped` is threaded through rather than dropped: a log quietly losing
  // lines must show up on the report's face, not as a smaller sample nobody
  // can see.
  const report = buildCostReport(records, skipped);

  await mkdir(COST_DIR, { recursive: true });
  await writeFile(MARKDOWN_OUT, renderCostMarkdown(report), "utf8");
  await writeFile(HTML_OUT, renderCostHtml(report), "utf8");

  console.log(`${report.totalRuns} run(s) read${skipped > 0 ? `, ${skipped} line(s) unreadable` : ""}.`);
  if (report.floorRuns > 0) {
    console.log(`${report.floorRuns} floor run(s) counted but excluded from every average.`);
  }
  console.log(`Wrote ${MARKDOWN_OUT}`);
  console.log(`Wrote ${HTML_OUT}`);
}

await main();
