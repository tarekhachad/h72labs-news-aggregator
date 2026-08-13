import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Cluster, Topic } from "@/types";

// Same fake-Anthropic-constructor pattern as dedup.test.ts's isSameStory
// tests — judgeBatch is the only thing in triage.ts that talks to Anthropic,
// and its response is fully controlled via this shared mock.
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  function FakeAnthropic() {
    return { messages: { parse: mockParse } };
  }
  return { default: FakeAnthropic };
});

function makeCluster(topic: Topic, title: string): Cluster {
  return {
    topic,
    articles: [
      {
        title,
        snippet: "A snippet",
        url: `https://example.com/${title}`,
        source: "BBC",
        topic,
        publishedAt: "2026-07-31T12:00:00Z",
      },
    ],
  };
}

/** n clusters, all one topic. */
function clustersOf(topic: Topic, n: number): Cluster[] {
  return Array.from({ length: n }, (_, i) => makeCluster(topic, `${topic}-${i}`));
}

/** A well-formed response judging every slot, severity = index + 1. */
function verdictsFor(count: number, notable = true) {
  return {
    parsed_output: {
      verdicts: Array.from({ length: count }, (_, i) => ({
        index: i,
        notable,
        severity: (i % 5) + 1,
      })),
    },
  };
}

beforeEach(() => {
  mockParse.mockReset();
  delete process.env.TRIAGE_REASONS;
});

afterEach(() => {
  delete process.env.TRIAGE_REASONS;
});

describe("planTriageBatches", () => {
  it("returns nothing for no clusters", async () => {
    const { planTriageBatches } = await import("@/lib/triage");
    expect(planTriageBatches([])).toEqual([]);
  });

  it("keeps one batch per topic below the size limit", async () => {
    const { planTriageBatches } = await import("@/lib/triage");
    const batches = planTriageBatches([
      ...clustersOf("Tech/AI", 3),
      ...clustersOf("Morocco", 2),
    ]);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual({ topic: "Tech/AI", indices: [0, 1, 2] });
    expect(batches[1]).toEqual({ topic: "Morocco", indices: [3, 4] });
  });

  it("never mixes topics in one batch, even when interleaved", async () => {
    // The prompt's calibration is topic-relative ("a typical day for THIS
    // topic"), so a mixed batch would ask the model to hold two bars at once.
    const { planTriageBatches } = await import("@/lib/triage");
    const clusters = [
      makeCluster("Tech/AI", "a"),
      makeCluster("Morocco", "b"),
      makeCluster("Tech/AI", "c"),
    ];

    const batches = planTriageBatches(clusters);

    for (const batch of batches) {
      for (const i of batch.indices) expect(clusters[i].topic).toBe(batch.topic);
    }
    // And the indices are into the ORIGINAL array, not a per-topic subarray.
    expect(batches.find((b) => b.topic === "Tech/AI")!.indices).toEqual([0, 2]);
    expect(batches.find((b) => b.topic === "Morocco")!.indices).toEqual([1]);
  });

  it("evens out batch sizes instead of leaving a runt", async () => {
    // 62 clusters must not go 20/20/20/2 -- a 2-cluster batch is judged at a
    // very different context density than a 20-cluster one.
    const { planTriageBatches } = await import("@/lib/triage");
    const sizes = planTriageBatches(clustersOf("Tech/AI", 62)).map((b) => b.indices.length);

    expect(sizes).toEqual([16, 16, 15, 15]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(62);
  });

  it("covers every cluster exactly once, at any size", async () => {
    const { planTriageBatches } = await import("@/lib/triage");
    for (const n of [1, 19, 20, 21, 40, 41, 100]) {
      const covered = planTriageBatches(clustersOf("Tech/AI", n)).flatMap((b) => b.indices);
      expect([...covered].sort((a, b) => a - b)).toEqual(
        Array.from({ length: n }, (_, i) => i)
      );
    }
  });

  it("never exceeds the per-batch ceiling", async () => {
    const { planTriageBatches } = await import("@/lib/triage");
    for (const n of [21, 41, 62, 100, 794]) {
      for (const batch of planTriageBatches(clustersOf("Tech/AI", n))) {
        expect(batch.indices.length).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe("triageBatchCount", () => {
  it("agrees with planTriageBatches for every shape", async () => {
    // These must not drift: triageBatchCount is what the cost summary
    // compares actual calls against, and a second copy of the arithmetic
    // would make the module whose premise is "a confidently wrong number is
    // worse than a crash" emit false warnings every run.
    const { planTriageBatches, triageBatchCount } = await import("@/lib/triage");
    const shapes: Cluster[][] = [
      [],
      clustersOf("Tech/AI", 1),
      clustersOf("Tech/AI", 20),
      clustersOf("Tech/AI", 21),
      clustersOf("Tech/AI", 62),
      [...clustersOf("Tech/AI", 25), ...clustersOf("Morocco", 30)],
    ];

    for (const shape of shapes) {
      expect(triageBatchCount(shape)).toBe(planTriageBatches(shape).length);
    }
  });

  it("collapses 794 single-cluster calls into a small number of batches", async () => {
    // The whole point of F.4.5: F.3 measured 794 triage calls for one digest.
    const { triageBatchCount } = await import("@/lib/triage");
    const nineTopics = Array.from({ length: 9 }, (_, t) =>
      clustersOf(`topic-${t}` as Topic, 88)
    ).flat();

    expect(nineTopics).toHaveLength(792);
    expect(triageBatchCount(nineTopics)).toBeLessThan(60);
  });
});

describe("triageClusters", () => {
  it("returns nothing, and makes no call, for no clusters", async () => {
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters([])).resolves.toEqual([]);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("maps each verdict back to its own cluster", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [
          { index: 0, notable: true, severity: 5 },
          { index: 1, notable: false, severity: 1 },
          { index: 2, notable: true, severity: 3 },
        ],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters(clustersOf("Tech/AI", 3))).resolves.toEqual([
      { notable: true, severity: 5 },
      { notable: false, severity: 1 },
      { notable: true, severity: 3 },
    ]);
  });

  it("MISALIGNMENT CANARY: verdicts returned in reverse order land on the right clusters", async () => {
    // Severities are distinct on purpose. A count-based or set-based
    // assertion passes under a rotation; only a per-index assertion catches
    // a mapping that silently shifts every verdict by one.
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [
          { index: 2, notable: true, severity: 3 },
          { index: 1, notable: true, severity: 4 },
          { index: 0, notable: true, severity: 5 },
        ],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters(clustersOf("Tech/AI", 3))).resolves.toEqual([
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
      { notable: true, severity: 3 },
    ]);
  });

  it("MISALIGNMENT CANARY: verdicts returned shuffled land on the right clusters", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [
          { index: 3, notable: true, severity: 2 },
          { index: 0, notable: true, severity: 5 },
          { index: 4, notable: false, severity: 1 },
          { index: 1, notable: true, severity: 4 },
          { index: 2, notable: true, severity: 3 },
        ],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters(clustersOf("Tech/AI", 5))).resolves.toEqual([
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
      { notable: true, severity: 3 },
      { notable: true, severity: 2 },
      { notable: false, severity: 1 },
    ]);
  });

  it("MISALIGNMENT CANARY: batch-local indices map to global positions across topics", async () => {
    // Interleaved topics: Tech/AI holds global 0 and 2, Morocco holds 1.
    // Each batch numbers its own clusters from 0, so a naive
    // "verdict.index === cluster index" would put Tech/AI's second verdict
    // onto Morocco's cluster.
    mockParse.mockImplementation(async ({ messages }) => {
      const content = messages[0].content as string;
      return content.includes("Topic: Tech/AI")
        ? {
            parsed_output: {
              verdicts: [
                { index: 0, notable: true, severity: 5 },
                { index: 1, notable: true, severity: 4 },
              ],
            },
          }
        : {
            parsed_output: { verdicts: [{ index: 0, notable: false, severity: 1 }] },
          };
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters([
      makeCluster("Tech/AI", "a"),
      makeCluster("Morocco", "b"),
      makeCluster("Tech/AI", "c"),
    ]);

    expect(outcomes).toEqual([
      { notable: true, severity: 5 },
      { notable: false, severity: 1 },
      { notable: true, severity: 4 },
    ]);
  });

  it("drops an out-of-range index rather than writing past the batch", async () => {
    // Only the first attempt carries the malformed indices; the retries
    // return nothing, so slot 1 stays genuinely unjudged. (A canned
    // mockResolvedValue would answer the one-cluster retry batch with the
    // same `index: 0` verdict and quietly judge slot 1 after all.)
    let first = true;
    mockParse.mockImplementation(async () => {
      if (!first) return { parsed_output: { verdicts: [] } };
      first = false;
      return {
        parsed_output: {
          verdicts: [
            { index: 0, notable: true, severity: 5 },
            { index: 9, notable: true, severity: 5 },
            { index: -1, notable: true, severity: 5 },
          ],
        },
      };
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 2));
    expect(outcomes[0]).toEqual({ notable: true, severity: 5 });
    // Index 1 was never judged -> fails closed, and nothing crashed.
    expect(outcomes[1]).toEqual({ notable: false, severity: 1 });
  });

  it("takes the first verdict when an index is repeated", async () => {
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [
          { index: 0, notable: true, severity: 5 },
          { index: 0, notable: false, severity: 1 },
        ],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 1));
    expect(outcomes[0]).toEqual({ notable: true, severity: 5 });
  });

  it("fails a missing verdict closed rather than shifting the ones that came back", async () => {
    // 3 clusters, only slots 0 and 2 judged. Slot 1 must be rejected, NOT
    // filled with slot 2's verdict. The retries return nothing so the gap
    // stays a gap — this is about mapping, not recovery.
    let first = true;
    mockParse.mockImplementation(async () => {
      if (!first) return { parsed_output: { verdicts: [] } };
      first = false;
      return {
        parsed_output: {
          verdicts: [
            { index: 0, notable: true, severity: 5 },
            { index: 2, notable: true, severity: 3 },
          ],
        },
      };
    });
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters(clustersOf("Tech/AI", 3))).resolves.toEqual([
      { notable: true, severity: 5 },
      { notable: false, severity: 1 },
      { notable: true, severity: 3 },
    ]);
  });
});

describe("triageClusters failure handling", () => {
  it("never rejects when the API throws — the route has no per-cluster catch anymore", async () => {
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters(clustersOf("Tech/AI", 4))).resolves.toEqual([
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
    ]);
  });

  it("treats a missing parsed_output as unjudged, not as 'nothing is notable'", async () => {
    // A truncated response is not a judgement. If it were read as one, a
    // whole batch of real stories would be silently rejected -- permanently,
    // since the since-cursor advances regardless.
    let calls = 0;
    mockParse.mockImplementation(async () => {
      calls += 1;
      // First (whole-batch) attempt truncates; the retries succeed.
      return calls === 1 ? { parsed_output: null, stop_reason: "max_tokens" } : verdictsFor(1);
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 2));
    expect(calls).toBeGreaterThan(1);
    expect(outcomes.every((o) => o.notable)).toBe(true);
  });

  it("splits and retries a failed batch, recovering the clusters", async () => {
    let calls = 0;
    mockParse.mockImplementation(async ({ messages }) => {
      calls += 1;
      if (calls === 1) throw new Error("first attempt fails");
      // Halves: count the numbered lines to answer the right size.
      const content = messages[0].content as string;
      const size = (content.match(/^\d+\. /gm) ?? []).length;
      return verdictsFor(size);
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 4));

    expect(outcomes.every((o) => o.notable)).toBe(true);
    // One failed whole-batch attempt, then two halves.
    expect(calls).toBe(3);
  });

  it("MISALIGNMENT CANARY: a retried sub-batch renumbering from 0 still maps back to the right global cluster", async () => {
    // The existing "splits and retries" test above only asserts
    // outcomes.every(notable) -- verdictsFor(size) happens to generate an
    // identical severity pattern for every same-sized half, so a bug that
    // stored a retry's verdicts under its own LOCAL index (e.g.
    // outcomes.set(verdict.index, ...) instead of
    // outcomes.set(indices[verdict.index], ...)) would, for THIS specific
    // input, only ever overwrite already-correct slots with the same
    // values, so it would still pass. Distinct severities per half, tied to
    // which titles the model actually saw, is what makes a real shift or
    // an accidental global-vs-local index conflation fail loudly instead of
    // by coincidence passing.
    mockParse.mockImplementation(async ({ messages }) => {
      const content = messages[0].content as string;
      const size = (content.match(/^\d+\. /gm) ?? []).length;
      if (size === 4) throw new Error("whole batch fails");
      if (content.includes("Tech/AI-0")) {
        // First half, global indices [0, 1], renumbered locally as 0, 1.
        return {
          parsed_output: {
            verdicts: [
              { index: 0, notable: true, severity: 5 },
              { index: 1, notable: true, severity: 4 },
            ],
          },
        };
      }
      // Second half, global indices [2, 3], ALSO renumbered locally as 0, 1
      // -- a naive implementation that used the local index as the global
      // key would collide with the first half's slots instead of landing
      // on clusters 2 and 3.
      return {
        parsed_output: {
          verdicts: [
            { index: 0, notable: true, severity: 2 },
            { index: 1, notable: false, severity: 1 },
          ],
        },
      };
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 4));

    expect(outcomes).toEqual([
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
      { notable: true, severity: 2 },
      { notable: false, severity: 1 },
    ]);
  });

  it("MISALIGNMENT CANARY: nested split-retry (one half recovers immediately, the other needs a second split) keeps every cluster on its own verdict", async () => {
    // Exercises both split depths in one run, with a healthy half (recovers
    // at depth 1) next to a half that itself fails and has to split again
    // (depth 2) -- and each of the four batches involved (the doomed whole
    // batch, the two depth-1 halves, and the two depth-2 quarters) is
    // renumbered from 0 independently. A shift at any one of those levels
    // would show up as a wrong value at a specific global position.
    mockParse.mockImplementation(async ({ messages }) => {
      const content = messages[0].content as string;
      const size = (content.match(/^\d+\. /gm) ?? []).length;
      if (size === 8) throw new Error("whole batch fails");
      if (size === 4 && content.includes("Tech/AI-0")) {
        // First half: global [0,1,2,3], recovers in one shot.
        return {
          parsed_output: {
            verdicts: [
              { index: 0, notable: true, severity: 5 },
              { index: 1, notable: true, severity: 4 },
              { index: 2, notable: true, severity: 3 },
              { index: 3, notable: true, severity: 2 },
            ],
          },
        };
      }
      if (size === 4 && content.includes("Tech/AI-4")) {
        // Second half: global [4,5,6,7], fails and forces a depth-2 split.
        throw new Error("second half fails");
      }
      if (size === 2 && content.includes("Tech/AI-4")) {
        // Depth-2 quarter: global [4,5], renumbered locally as 0,1 again.
        return {
          parsed_output: {
            verdicts: [
              { index: 0, notable: true, severity: 1 },
              { index: 1, notable: true, severity: 5 },
            ],
          },
        };
      }
      // Depth-2 quarter: global [6,7], also renumbered locally as 0,1.
      return {
        parsed_output: {
          verdicts: [
            { index: 0, notable: false, severity: 1 },
            { index: 1, notable: true, severity: 2 },
          ],
        },
      };
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 8));

    expect(outcomes).toEqual([
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
      { notable: true, severity: 3 },
      { notable: true, severity: 2 },
      { notable: true, severity: 1 },
      { notable: true, severity: 5 },
      { notable: false, severity: 1 },
      { notable: true, severity: 2 },
    ]);
    // 1 (whole batch) + 2 (depth-1 halves) + 2 (depth-2 quarters for the
    // failing half only -- the healthy half never needed to split).
    expect(mockParse).toHaveBeenCalledTimes(5);
  });

  it("bounds the retry ladder instead of splitting forever", async () => {
    mockParse.mockRejectedValue(new Error("always fails"));
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 20));

    expect(outcomes).toHaveLength(20);
    expect(outcomes.every((o) => !o.notable)).toBe(true);
    // depth 0 (1 call) + depth 1 (2) + depth 2 (4) = 7, and no more.
    expect(mockParse).toHaveBeenCalledTimes(7);
  });

  it("isolates a failing batch from a healthy one in another topic", async () => {
    mockParse.mockImplementation(async ({ messages }) => {
      const content = messages[0].content as string;
      if (content.includes("Topic: Morocco")) throw new Error("this topic fails");
      const size = (content.match(/^\d+\. /gm) ?? []).length;
      return verdictsFor(size);
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters([
      ...clustersOf("Tech/AI", 2),
      ...clustersOf("Morocco", 2),
    ]);

    expect(outcomes[0].notable).toBe(true);
    expect(outcomes[1].notable).toBe(true);
    expect(outcomes[2]).toEqual({ notable: false, severity: 1 });
    expect(outcomes[3]).toEqual({ notable: false, severity: 1 });
  });

  it("does not let a FAILURE-path logging error break the never-rejects contract", async () => {
    // The success-path log is guarded (next test). This is the other one:
    // the console.error in the split-retry ladder's catch block. It sits
    // between a failed batch and triageClusters' return, so an unguarded
    // throw there escapes the catch, propagates through the Promise.all,
    // and rejects — which the route no longer defends against, having
    // given up its per-cluster catch on the strength of that contract.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr closed");
    });
    mockParse.mockRejectedValue(new Error("rate limited"));
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters(clustersOf("Tech/AI", 2))).resolves.toEqual([
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
    ]);

    spy.mockRestore();
  });

  it("does not let a logging failure discard an already-paid-for verdict", async () => {
    // The log runs after the call has resolved and been billed. Unguarded, a
    // throw here is indistinguishable from the API call failing and would
    // send a whole batch back through the retry ladder.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout closed");
    });
    mockParse.mockResolvedValue(verdictsFor(2));
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 2));

    expect(outcomes.every((o) => o.notable)).toBe(true);
    expect(mockParse).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("holds the never-rejects contract when BOTH loggers throw during a partially-successful batch — success-path console.log and failure-path console.error firing together, not just in isolation", async () => {
    // The two existing tests above each throw exactly one logger in
    // isolation (log-only success, error-only failure). Round 4's defect
    // was specifically in the failure-path guard, found after four rounds
    // had already exercised the success-path one -- so this pins the
    // combination explicitly: one call judges some clusters (hits the
    // guarded console.log) while others in the same run fail and retry
    // (hits the guarded console.error), with BOTH loggers throwing at once,
    // across every depth the ladder actually uses.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout closed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("stderr closed");
    });

    mockParse.mockImplementation(async ({ messages }) => {
      const content = messages[0].content as string;
      const size = (content.match(/^\d+\. /gm) ?? []).length;
      if (size === 4) {
        // Whole batch (global [0,1,2,3]): judges 0 and 1 only, leaving 2
        // and 3 unjudged -- a genuinely partial success, not a total
        // failure. Fires the guarded console.log twice.
        return {
          parsed_output: {
            verdicts: [
              { index: 0, notable: true, severity: 5 },
              { index: 1, notable: true, severity: 4 },
            ],
          },
        };
      }
      if (content.includes("Tech/AI-2")) {
        // Global cluster 2's half: fails at every depth it's retried at
        // (depth 1 and depth 2), each time firing the guarded
        // console.error.
        throw new Error("cluster 2 always fails");
      }
      // Global cluster 3's half: recovers on its first retry, firing the
      // guarded console.log again.
      return {
        parsed_output: { verdicts: [{ index: 0, notable: true, severity: 2 }] },
      };
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 4));

    expect(outcomes).toEqual([
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
      { notable: false, severity: 1 }, // failed-closed after the ladder bottoms out
      { notable: true, severity: 2 },
    ]);
    // 1 (whole batch) + depth-1 halves for [2] and [3] + depth-2 retry of
    // [2] alone (it never had a partner to pair with once [3] recovered).
    expect(mockParse).toHaveBeenCalledTimes(4);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("triage reason gating", () => {
  it("omits reasons from the schema by default", async () => {
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters(clustersOf("Tech/AI", 1));

    const { system } = mockParse.mock.calls[0][0];
    expect(system).not.toContain("at most 12 words");
  });

  it("raises the output budget when reasons are on, so a full batch can't truncate", async () => {
    // Reasons roughly double a verdict's size. At the default budget a full
    // 20-verdict batch lands near the ceiling, and the 12-word cap is a
    // prompt instruction rather than a schema constraint -- an overrun would
    // truncate and burn paid retries during exactly the calibration run
    // reasons exist for. Costs nothing when unused: output tokens are billed
    // as generated, not as budgeted.
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters(clustersOf("Tech/AI", 1));
    const withoutReasons = mockParse.mock.calls[0][0].max_tokens;

    process.env.TRIAGE_REASONS = "1";
    await triageClusters(clustersOf("Tech/AI", 1));
    const withReasons = mockParse.mock.calls[1][0].max_tokens;

    expect(withReasons).toBeGreaterThan(withoutReasons);
    // Enough for 20 verdicts carrying a ~12-word reason each.
    expect(withReasons).toBeGreaterThanOrEqual(2048);
  });

  it("asks for a capped reason when TRIAGE_REASONS=1", async () => {
    process.env.TRIAGE_REASONS = "1";
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters(clustersOf("Tech/AI", 1));

    const { system } = mockParse.mock.calls[0][0];
    expect(system).toContain("at most 12 words");
    // The calibration prompt itself must be unchanged, not rewritten.
    expect(system).toContain("typical-day baseline");
  });

  it("reads the flag per call, so a run can flip it without a reimport", async () => {
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");

    await triageClusters(clustersOf("Tech/AI", 1));
    process.env.TRIAGE_REASONS = "1";
    await triageClusters(clustersOf("Tech/AI", 1));

    expect(mockParse.mock.calls[0][0].system).not.toContain("at most 12 words");
    expect(mockParse.mock.calls[1][0].system).toContain("at most 12 words");
  });
});

describe("F.4.5 round 2: split-retry ladder edge cases", () => {
  it("a truncated response with TRIAGE_REASONS=1 still recovers through the split-retry ladder", async () => {
    // Simulates the exact risk this round was asked to check: a full
    // 20-verdict batch with reasons on truncating against the raised
    // 2048-token ceiling. The whole-batch attempt truncates (parsed_output
    // null, stop_reason max_tokens); the halves succeed.
    process.env.TRIAGE_REASONS = "1";
    let first = true;
    mockParse.mockImplementation(async ({ messages, max_tokens }) => {
      expect(max_tokens).toBe(2048);
      const content = messages[0].content as string;
      const size = (content.match(/^\d+\. /gm) ?? []).length;
      if (first && size === 20) {
        first = false;
        return { parsed_output: null, stop_reason: "max_tokens" };
      }
      return verdictsFor(size);
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 20));

    expect(outcomes).toHaveLength(20);
    expect(outcomes.every((o) => o.notable)).toBe(true);
    // 1 truncated whole-batch attempt + 2 halves that both succeed.
    expect(mockParse).toHaveBeenCalledTimes(3);
  });

  it("a batch of exactly one cluster that always fails terminates in 3 calls, not an infinite split", async () => {
    // A single-element batch can never produce two non-empty halves, so the
    // ladder degenerates to retrying the same one-cluster batch at
    // increasing depth rather than 1+2+4=7. Worth pinning explicitly since
    // the module's own comment describes the 7-call worst case as if it
    // always applies.
    mockParse.mockRejectedValue(new Error("always fails"));
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 1));

    expect(outcomes).toEqual([{ notable: false, severity: 1 }]);
    expect(mockParse).toHaveBeenCalledTimes(3);
  });

  it("every verdict out of range in the whole batch fails closed after the ladder, without crashing", async () => {
    // Every returned index is nonsense (negative, or >= batch size) at every
    // depth, so the outcomes map is empty on every attempt. This must not
    // throw, must not misindex, and must terminate at the depth cap.
    mockParse.mockImplementation(async ({ messages }) => {
      const content = messages[0].content as string;
      const size = (content.match(/^\d+\. /gm) ?? []).length;
      return {
        parsed_output: {
          verdicts: [
            { index: -1, notable: true, severity: 5 },
            { index: size + 10, notable: true, severity: 5 },
            { index: 999, notable: true, severity: 5 },
          ],
        },
      };
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 4));

    expect(outcomes).toEqual([
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
      { notable: false, severity: 1 },
    ]);
    // depth 0 (1) + depth 1 (2 halves of 2) + depth 2 (4 quarters of 1) = 7.
    expect(mockParse).toHaveBeenCalledTimes(7);
  });

  it("MORE verdicts than clusters in one response resolves each cluster distinctly, ignoring the surplus", async () => {
    // 3 clusters, 5 verdicts returned: two are repeats of already-seen
    // indices with DIFFERENT severities. First-wins must hold even when the
    // repeat isn't adjacent to the original, and the surplus must not shift
    // any other cluster's verdict.
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [
          { index: 0, notable: true, severity: 5 },
          { index: 1, notable: true, severity: 4 },
          { index: 2, notable: true, severity: 3 },
          { index: 0, notable: false, severity: 1 },
          { index: 1, notable: false, severity: 1 },
        ],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    await expect(triageClusters(clustersOf("Tech/AI", 3))).resolves.toEqual([
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
      { notable: true, severity: 3 },
    ]);
  });

  it("an odd unjudged count at depth 1 splits unevenly (3/2) and both halves still land on the right global clusters", async () => {
    // 5 clusters, whole batch fails. mid = ceil(5/2) = 3, so the halves are
    // sizes 3 and 2, not equal. Distinct severities per half catch a global/
    // local index mixup the same way the existing nested-split canary does,
    // but for an odd split rather than the even 4->2/2 case already covered.
    mockParse.mockImplementation(async ({ messages }) => {
      const content = messages[0].content as string;
      const size = (content.match(/^\d+\. /gm) ?? []).length;
      if (size === 5) throw new Error("whole batch fails");
      if (size === 3) {
        return {
          parsed_output: {
            verdicts: [
              { index: 0, notable: true, severity: 5 },
              { index: 1, notable: true, severity: 4 },
              { index: 2, notable: true, severity: 3 },
            ],
          },
        };
      }
      // size === 2, global indices [3, 4], renumbered locally as 0, 1.
      return {
        parsed_output: {
          verdicts: [
            { index: 0, notable: true, severity: 2 },
            { index: 1, notable: false, severity: 1 },
          ],
        },
      };
    });
    const { triageClusters } = await import("@/lib/triage");

    const outcomes = await triageClusters(clustersOf("Tech/AI", 5));

    expect(outcomes).toEqual([
      { notable: true, severity: 5 },
      { notable: true, severity: 4 },
      { notable: true, severity: 3 },
      { notable: true, severity: 2 },
      { notable: false, severity: 1 },
    ]);
    // 1 (whole batch) + 2 (the 3/2 halves), neither half needed to split further.
    expect(mockParse).toHaveBeenCalledTimes(3);
  });

  it("returns an array exactly clusters.length long, with no undefined slots, across a spread of failure shapes", async () => {
    // A generic property check rather than one specific scenario: whatever
    // mix of throw / malformed / out-of-range / partial happens, the
    // contract triageClusters makes to its caller (one real TriageOutcome
    // per input cluster, in order) must hold, since the route indexes into
    // this array positionally with no further validation.
    const scenarios: Array<() => void> = [
      () => mockParse.mockRejectedValue(new Error("network")),
      () => mockParse.mockResolvedValue({ parsed_output: null, stop_reason: "max_tokens" }),
      () =>
        mockParse.mockResolvedValue({
          parsed_output: { verdicts: [{ index: 0, notable: true, severity: 5 }] },
        }),
      () =>
        mockParse.mockResolvedValue({
          parsed_output: { verdicts: [{ index: 999, notable: true, severity: 5 }] },
        }),
    ];

    for (const size of [1, 3, 7, 20, 23]) {
      for (const setup of scenarios) {
        mockParse.mockReset();
        setup();
        const { triageClusters } = await import("@/lib/triage");
        const outcomes = await triageClusters(clustersOf("Tech/AI", size));

        expect(outcomes).toHaveLength(size);
        for (const o of outcomes) {
          expect(o).toBeDefined();
          expect(typeof o.notable).toBe("boolean");
          expect(typeof o.severity).toBe("number");
        }
      }
    }
  });
});
