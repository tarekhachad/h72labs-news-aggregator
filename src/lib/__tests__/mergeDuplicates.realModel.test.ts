import { describe, it, expect } from "vitest";
import { cosineSimilarity, embed } from "@/lib/embeddings";
import { CANDIDATE_THRESHOLD } from "@/lib/mergeDuplicates";
import {
  BACKGROUND,
  MEASURED_SCORES,
  MUST_MERGE,
  MUST_NOT_MERGE,
  REWORDED_SAME_EVENT,
  SAME_PATTERN_DIFFERENT_EVENTS,
  sameEvent,
  type FixtureCluster,
} from "./fixtures/duplicateEvents";

// Re-measures the scores mergeDuplicates.test.ts pins, with the vendored model
// itself. Skipped by default (the suite never loads the model); run it after
// changing a fixture sentence, the model, or CANDIDATE_THRESHOLD:
//
//   MERGE_REAL_MODEL=1 npx vitest run src/lib/__tests__/mergeDuplicates.realModel.test.ts

const TOLERANCE = 0.005;

async function scores(clusters: FixtureCluster[]): Promise<Map<string, number>> {
  const vectors = await embed(clusters.map((c) => c.event));
  const out = new Map<string, number>();
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      out.set(`${clusters[i].id}|${clusters[j].id}`, cosineSimilarity(vectors[i], vectors[j]));
    }
  }
  return out;
}

function pinned(key: string): number | undefined {
  const [a, b] = key.split("|");
  return MEASURED_SCORES[key] ?? MEASURED_SCORES[`${b}|${a}`];
}

describe.skipIf(process.env.MERGE_REAL_MODEL !== "1")("pinned scores against the real model", () => {
  it("the evidence day: every listed pair matches, every other pair is below 0.40", async () => {
    const measured = await scores([...MUST_MERGE.flat(), ...MUST_NOT_MERGE.flat(), ...BACKGROUND]);

    for (const [key, score] of measured) {
      const expected = pinned(key);
      if (expected === undefined) expect(score, key).toBeLessThan(0.4);
      else expect(Math.abs(score - expected), key).toBeLessThanOrEqual(TOLERANCE);
    }
  }, 60_000);

  it("the same-pattern and reworded pairs match", async () => {
    for (const pair of [...SAME_PATTERN_DIFFERENT_EVENTS, REWORDED_SAME_EVENT]) {
      const [[key, score]] = await scores(pair);
      expect(Math.abs(score - pinned(key)!), key).toBeLessThanOrEqual(TOLERANCE);
    }
  }, 60_000);

  it("every same-event pair reaches Haiku, and the threshold sits above the unrelated background", async () => {
    const day = [...MUST_MERGE.flat(), ...MUST_NOT_MERGE.flat(), ...BACKGROUND];
    const measured = await scores(day);
    const related = new Set(MUST_NOT_MERGE.map(([a, b]) => `${a.id}|${b.id}`));

    for (const [key, score] of measured) {
      const [a, b] = key.split("|");
      if (sameEvent(a, b)) expect(score, key).toBeGreaterThanOrEqual(CANDIDATE_THRESHOLD);
      else if (!related.has(key)) expect(score, key).toBeLessThan(CANDIDATE_THRESHOLD);
    }
    const [[, reworded]] = await scores(REWORDED_SAME_EVENT);
    expect(reworded).toBeGreaterThanOrEqual(CANDIDATE_THRESHOLD);
  }, 60_000);
});
