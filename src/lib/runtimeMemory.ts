/**
 * Stage-boundary memory marks for the digest pipeline.
 *
 * A serverless instance gets 2048 MB and is killed outright when it exceeds
 * that — no JavaScript runs, so the spend reservation and the generation claim
 * are both left behind and nothing records why. That is not hypothetical: a
 * 5-topic profile pulling 663 articles was killed 5 seconds into a run, and
 * the platform log said only "ran out of available memory". Local runs of the
 * same work peak around 150 MB, so the cause is specific to the deployed
 * runtime and cannot be found by measuring here.
 *
 * These marks are what make that diagnosable: a kill between two marks names
 * the stage responsible, and the counts alongside each mark say how much work
 * that stage was holding. Point-in-time readings, deliberately — sampling on a
 * timer would add a handle to clean up on every exit path in a function whose
 * exit paths already carry the money.
 */

/** Resident set size in whole MB, the figure the platform's limit is stated in. */
function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1048576);
}

export function memoryMark(stage: string, facts: Record<string, number> = {}): void {
  const detail = Object.entries(facts)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(`[mem] ${stage} rss=${rssMb()}MB${detail ? " " + detail : ""}`);
}
