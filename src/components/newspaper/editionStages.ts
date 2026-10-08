import { STAGE_ORDER, type Stage, type StageEvent } from "@/components/newspaper/DigestGenerationContext";

export const STAGE_LABEL: Record<Stage, string> = {
  ingesting: "Gathering articles…",
  clustering: "Grouping articles into stories…",
  triaging: "Checking stories for notability…",
  writing: "Writing cards…",
  ranking: "Picking today's front page…",
  done: "Done",
};

/** The stage in words, with the run's own counts once the server has sent them. */
export function stageLabel(stage: Stage, event: Record<string, unknown>): string {
  if (stage === "clustering" && typeof event.articleCount === "number") {
    return `Grouping ${event.articleCount} articles into stories…`;
  }
  if (stage === "triaging" && typeof event.clusterCount === "number") {
    return `Checking ${event.clusterCount} stories for notability…`;
  }
  if (stage === "writing" && typeof event.notableCount === "number") {
    const n = event.notableCount as number;
    return `Writing ${n} card${n === 1 ? "" : "s"}…`;
  }
  return STAGE_LABEL[stage];
}

/** The sentence for a run in flight; a run that has sent nothing yet is gathering. */
export function runningStageLabel(event: StageEvent | null): string {
  return event ? stageLabel(event.stage, event) : STAGE_LABEL.ingesting;
}

/** The progress rail's five steps, one per pipeline stage before `done`, in STAGE_ORDER's order. */
export const RAIL_STEPS = ["Wires", "Stories", "Desk", "Writing", "Front page"] as const;

/**
 * How many rail steps are lit: the stage in progress counts as reached, so
 * the first step lights the moment a run starts and all five by the time the
 * front page is being picked.
 */
export function railStepsReached(event: StageEvent | null): number {
  const index = event ? STAGE_ORDER.indexOf(event.stage) : 0;
  return Math.min(RAIL_STEPS.length, Math.max(0, index) + 1);
}
