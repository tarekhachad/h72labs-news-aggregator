import { describe, it, expect, vi, beforeEach } from "vitest";

// embed() is the backstop: callers bound their own text, and this bound sits
// above theirs so a caller that forgets cannot hand the model an item long
// enough to exhaust the instance (a 48,191-character feed item killed one).
// The batch size is the other half — attention memory is batch x longest^2.

const mocks = vi.hoisted(() => ({ pipeline: vi.fn(), seen: [] as string[][] }));
vi.mock("@xenova/transformers", () => ({
  env: { allowRemoteModels: true, allowLocalModels: true, useFSCache: true, localModelPath: "" },
  pipeline: mocks.pipeline,
}));

import { embed } from "@/lib/embeddings";

beforeEach(() => {
  mocks.seen.length = 0;
  mocks.pipeline.mockReset();
  mocks.pipeline.mockResolvedValue(async (batch: string[]) => {
    mocks.seen.push(batch);
    return { dims: [batch.length, 2], data: new Float32Array(batch.flatMap(() => [1, 0])) };
  });
});

describe("embed", () => {
  it("clips any text past 2000 characters before the model sees it", async () => {
    await embed(["short", "L".repeat(48191)]);

    expect(mocks.seen[0][0]).toBe("short");
    expect(mocks.seen[0][1]).toHaveLength(2000);
  });

  it("sends at most 32 texts per batch, so one long item cannot cost more than its own batch", async () => {
    await embed(Array.from({ length: 70 }, (_, i) => `text ${i}`));

    expect(mocks.seen.map((b) => b.length)).toEqual([32, 32, 6]);
  });

  it("returns one vector per input, in order, across batch boundaries", async () => {
    const vectors = await embed(Array.from({ length: 33 }, (_, i) => `text ${i}`));

    expect(vectors).toHaveLength(33);
    expect(vectors[0]).toEqual([1, 0]);
  });
});
