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

// The per-verdict log line is the only per-cluster record a triage run
// leaves behind, and F.4.6's cost measurement runs with TRIAGE_REASONS=0 —
// so without the story's title in it, a capture says a verdict was reached
// but never about what, and calibration can't be audited without paying for
// per-verdict reasons. These pin the title's presence, its shape, and (most
// importantly) that it can never throw on the un-guarded path where it runs.
describe("triage log line", () => {
  function captureLines(fn: () => Promise<unknown>) {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    return fn().then((result) => {
      spy.mockRestore();
      return { lines: lines.filter((l) => l.startsWith("[triage]")), result };
    });
  }

  it("names the story each verdict was about", async () => {
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "Anthropic ships a new model")])
    );

    expect(lines).toEqual([
      '[triage] Tech/AI — PASS (severity 1) — "Anthropic ships a new model"',
    ]);
  });

  it("names the story on a reject too", async () => {
    mockParse.mockResolvedValue(verdictsFor(1, false));
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("Morocco", "A routine ministry reshuffle")])
    );

    expect(lines).toEqual([
      '[triage] Morocco — reject — "A routine ministry reshuffle"',
    ]);
  });

  it("truncates a long title rather than flooding the capture", async () => {
    const long = "x".repeat(200);
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", long)])
    );

    expect(lines[0]).toBe(`[triage] Tech/AI — PASS (severity 1) — "${"x".repeat(80)}…"`);
  });

  it("truncates at exactly one character over the limit, and not at the limit", async () => {
    // Pins the > boundary itself. The 200-char case above is unaffected by
    // an off-by-one, so without this a > -> >= slip goes unnoticed.
    const { triageClusters } = await import("@/lib/triage");

    mockParse.mockResolvedValue(verdictsFor(1));
    const atLimit = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "y".repeat(80))])
    );
    expect(atLimit.lines[0]).toBe(`[triage] Tech/AI — PASS (severity 1) — "${"y".repeat(80)}"`);

    mockParse.mockResolvedValue(verdictsFor(1));
    const overLimit = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "y".repeat(81))])
    );
    expect(overLimit.lines[0]).toBe(`[triage] Tech/AI — PASS (severity 1) — "${"y".repeat(80)}…"`);
  });

  it("truncates by code point, so a non-BMP character can't be cut in half", async () => {
    // Real feeds carry emoji and non-BMP characters. Slicing by UTF-16 code
    // unit at a boundary that lands mid-pair emits a lone surrogate.
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");
    // 79 ASCII + an emoji = 80 code points but 81 code units, so a
    // code-unit slice at 80 would split the pair.
    const straddling = `${"z".repeat(79)}🚀`;

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", straddling)])
    );

    expect(lines[0]).toBe(`[triage] Tech/AI — PASS (severity 1) — "${straddling}"`);
    expect(lines[0]).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("keeps the title a single unambiguous field when it contains dashes, quotes or newlines", async () => {
    // The line is what an audit of a reasons-off capture parses. A headline
    // carrying its own " — " or a stray newline would otherwise split into
    // segments indistinguishable from the verdict/title/reason boundaries.
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([
        makeCluster("US Finance", 'Fed hikes rates — third\nthis year, says "the chair"'),
      ])
    );

    expect(lines[0]).toBe(
      `[triage] US Finance — PASS (severity 1) — "Fed hikes rates — third this year, says 'the chair'"`
    );
    expect(lines[0].split("\n")).toHaveLength(1);
  });

  it("survives a title that throws when read, without losing the batch's other verdicts", async () => {
    // The expensive case. A getter that succeeds while the prompt is built
    // (so the call is made and BILLED) but throws on this later read would,
    // if unguarded, escape judgeBatch and discard every verdict in that
    // already-paid-for response — not just this cluster's.
    let reads = 0;
    const poisoned = makeCluster("Tech/AI", "placeholder");
    Object.defineProperty(poisoned.articles[0], "title", {
      get() {
        reads += 1;
        if (reads > 1) throw new Error("title read blew up");
        return "Readable exactly once";
      },
    });

    mockParse.mockResolvedValue(verdictsFor(2));
    const { triageClusters } = await import("@/lib/triage");

    const { lines, result } = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "A healthy story"), poisoned])
    );

    // Both verdicts survive, and only one API call was needed — no retry.
    expect(result).toEqual([
      { notable: true, severity: 1 },
      { notable: true, severity: 2 },
    ]);
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      '[triage] Tech/AI — PASS (severity 1) — "A healthy story"',
      "[triage] Tech/AI — PASS (severity 2)",
    ]);
  });

  it("flattens the reason too, so one verdict can never look like two records", async () => {
    // The reason is unconstrained model output — z.string() with no .max(),
    // and the 12-word cap is only a prompt instruction. An embedded newline
    // would split one verdict across what reads as two [triage] lines, in
    // exactly the reasons-on capture used to investigate calibration.
    process.env.TRIAGE_REASONS = "1";
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [
          {
            index: 0,
            notable: true,
            severity: 3,
            reason: 'major ruling,\nnot  "routine" ',
          },
        ],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("US Politics", "Court rules on tariffs")])
    );

    expect(lines).toEqual([
      `[triage] US Politics — PASS (severity 3) — "Court rules on tariffs" — major ruling, not 'routine'`,
    ]);
    expect(lines[0].split("\n")).toHaveLength(1);
  });

  it("caps an overlong reason, the field most likely to overrun", async () => {
    // The 12-word limit is a prompt instruction, not a schema constraint —
    // z.string() carries no .max() on purpose, since a length violation
    // would fail validation and kill a batch of already-paid-for verdicts.
    // So the log line is where the bound has to live.
    process.env.TRIAGE_REASONS = "1";
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [{ index: 0, notable: true, severity: 3, reason: "w".repeat(500) }],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "A story")])
    );

    expect(lines[0]).toBe(
      `[triage] Tech/AI — PASS (severity 3) — "A story" — ${"w".repeat(160)}…`
    );
  });

  it("caps the reason at exactly one code point over the limit, and not at the limit", async () => {
    process.env.TRIAGE_REASONS = "1";
    const { triageClusters } = await import("@/lib/triage");

    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [{ index: 0, notable: true, severity: 3, reason: "w".repeat(160) }],
      },
    });
    const atLimit = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "A story")])
    );
    expect(atLimit.lines[0]).toBe(
      `[triage] Tech/AI — PASS (severity 3) — "A story" — ${"w".repeat(160)}`
    );

    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [{ index: 0, notable: true, severity: 3, reason: "w".repeat(161) }],
      },
    });
    const overLimit = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "A story")])
    );
    expect(overLimit.lines[0]).toBe(
      `[triage] Tech/AI — PASS (severity 3) — "A story" — ${"w".repeat(160)}…`
    );
  });

  it("caps the reason by code point too, so a non-BMP character can't be cut in half", async () => {
    process.env.TRIAGE_REASONS = "1";
    // 159 ASCII + an emoji = 160 code points but 161 code units.
    const straddling = `${"v".repeat(159)}🚀`;
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [{ index: 0, notable: true, severity: 3, reason: straddling }],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "A story")])
    );

    expect(lines[0]).toBe(`[triage] Tech/AI — PASS (severity 3) — "A story" — ${straddling}`);
    expect(lines[0]).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("omits a whitespace-only title rather than logging empty quotes", async () => {
    // The title-side mirror of the reason test below. Both fields share
    // flattenForLog today, so this is only distinguishable if the two
    // helpers are ever forked — which is exactly when a silent regression
    // here would otherwise go uncaught.
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "  \n\t ")])
    );

    expect(lines).toEqual(["[triage] Tech/AI — PASS (severity 1)"]);
  });

  it("omits a whitespace-only reason rather than leaving a dangling separator", async () => {
    process.env.TRIAGE_REASONS = "1";
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [{ index: 0, notable: true, severity: 3, reason: "   \n  " }],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("Tech/AI", "A story")])
    );

    expect(lines[0]).toBe(`[triage] Tech/AI — PASS (severity 3) — "A story"`);
  });

  it("survives a reason that throws when read, without losing the batch's other verdicts", async () => {
    // loggedReason shares loggedHeadline's failure surface exactly — same
    // unguarded line, same already-billed response — but nothing pinned its
    // guard: deleting loggedReason's try/catch outright left every other
    // test in this file green.
    process.env.TRIAGE_REASONS = "1";
    const poisoned = { index: 1, notable: true, severity: 2 };
    Object.defineProperty(poisoned, "reason", {
      enumerable: true,
      get() {
        throw new Error("reason read blew up");
      },
    });
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [{ index: 0, notable: true, severity: 3, reason: "fine" }, poisoned],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    const { lines, result } = await captureLines(() =>
      triageClusters([
        makeCluster("Tech/AI", "A healthy story"),
        makeCluster("Tech/AI", "The poisoned one"),
      ])
    );

    expect(result).toEqual([
      { notable: true, severity: 3 },
      { notable: true, severity: 2 },
    ]);
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      '[triage] Tech/AI — PASS (severity 3) — "A healthy story" — fine',
      '[triage] Tech/AI — PASS (severity 2) — "The poisoned one"',
    ]);
  });

  it("survives a throw from the reason TRANSFORM, not just the reason read", async () => {
    // loggedReason's counterpart to the title-transform test below. Its
    // guard has the same scope hazard: narrowed to wrap only the property
    // read, a throw from flattenForLog's internals escapes judgeBatch and
    // re-sends an already-billed batch — and it would do so during
    // TRIAGE_REASONS=1 specifically, the paid calibration run this field
    // exists for. The existing throwing-getter test can't catch that.
    process.env.TRIAGE_REASONS = "1";
    const poisoned = "reason that explodes on transform";
    const original = String.prototype.replace;
    const spy = vi
      .spyOn(String.prototype, "replace")
      .mockImplementation(function (this: string, ...args: unknown[]) {
        if (String(this) === poisoned) throw new Error("replace blew up");
        return (original as (...a: unknown[]) => string).apply(this, args);
      } as typeof String.prototype.replace);

    try {
      mockParse.mockResolvedValue({
        parsed_output: {
          verdicts: [
            { index: 0, notable: true, severity: 3, reason: "fine" },
            { index: 1, notable: true, severity: 2, reason: poisoned },
          ],
        },
      });
      const { triageClusters } = await import("@/lib/triage");

      const { lines, result } = await captureLines(() =>
        triageClusters([
          makeCluster("Tech/AI", "A healthy story"),
          makeCluster("Tech/AI", "The other story"),
        ])
      );

      expect(result).toEqual([
        { notable: true, severity: 3 },
        { notable: true, severity: 2 },
      ]);
      expect(mockParse).toHaveBeenCalledTimes(1);
      expect(lines).toEqual([
        '[triage] Tech/AI — PASS (severity 3) — "A healthy story" — fine',
        '[triage] Tech/AI — PASS (severity 2) — "The other story"',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("survives a throw from the title TRANSFORM, not just the title read", async () => {
    // Pins the guard's SCOPE rather than its existence. Every other test
    // here throws from the property getter, which a catch wrapped around
    // only the read would also survive — so without this, narrowing the
    // guard back to just the read leaves the whole suite green while
    // reopening the defect: a throw in replace/trim/slice escapes
    // judgeBatch and discards an entire already-billed response's verdicts.
    //
    // Tampering is scoped to this one title string so the SDK and zod,
    // which also call replace while the request is built, are unaffected.
    const poisoned = "Title that explodes on transform";
    const original = String.prototype.replace;
    const spy = vi
      .spyOn(String.prototype, "replace")
      .mockImplementation(function (this: string, ...args: unknown[]) {
        if (String(this) === poisoned) throw new Error("replace blew up");
        return (original as (...a: unknown[]) => string).apply(this, args);
      } as typeof String.prototype.replace);

    try {
      mockParse.mockResolvedValue(verdictsFor(2));
      const { triageClusters } = await import("@/lib/triage");

      const { lines, result } = await captureLines(() =>
        triageClusters([
          makeCluster("Tech/AI", "A healthy story"),
          makeCluster("Tech/AI", poisoned),
        ])
      );

      expect(result).toEqual([
        { notable: true, severity: 1 },
        { notable: true, severity: 2 },
      ]);
      expect(mockParse).toHaveBeenCalledTimes(1);
      expect(lines).toEqual([
        '[triage] Tech/AI — PASS (severity 1) — "A healthy story"',
        "[triage] Tech/AI — PASS (severity 2)",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("omits a non-string title rather than stringifying it", async () => {
    // Keeps the log line's template literal from invoking a foreign
    // toString. A number is the case that actually reaches loggedHeadline:
    // a title whose toString THROWS never gets that far, because
    // clusterContext interpolates every title while building the prompt, so
    // that batch fails closed before the call is made — see the next test.
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");
    const cluster = makeCluster("Tech/AI", "placeholder");
    (cluster.articles[0] as { title: unknown }).title = 42;

    const { lines, result } = await captureLines(() => triageClusters([cluster]));

    expect(lines).toEqual(["[triage] Tech/AI — PASS (severity 1)"]);
    expect(result).toEqual([{ notable: true, severity: 1 }]);
  });

  it("fails a title that throws while the prompt is built closed, before spending anything", async () => {
    // Documents where that hazard actually lands: clusterContext throws
    // before recordCall, so nothing is billed, the split-retry ladder runs
    // and gives up, and triageClusters still honours its never-rejects
    // contract by returning one fail-closed outcome per cluster.
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");
    const cluster = makeCluster("Tech/AI", "placeholder");
    (cluster.articles[0] as { title: unknown }).title = {
      toString() {
        throw new Error("toString blew up");
      },
    };

    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcomes = await triageClusters([cluster]);
    vi.mocked(console.error).mockRestore();

    expect(outcomes).toEqual([{ notable: false, severity: 1 }]);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it("logs without a title, and without throwing, for a cluster with no articles", async () => {
    // The load-bearing case. This runs OUTSIDE the guarded console.log, so a
    // throw here would escape judgeBatch into the split-retry ladder and
    // re-send a whole batch of already-billed verdicts. Articles is typed
    // Article[] with no non-empty guarantee, so this has to be total.
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");
    const empty: Cluster = { topic: "Tech/AI", articles: [] };

    const { lines, result } = await captureLines(() => triageClusters([empty]));

    expect(lines).toEqual(["[triage] Tech/AI — PASS (severity 1)"]);
    expect(result).toEqual([{ notable: true, severity: 1 }]);
  });

  it("keeps the title distinguishable from the reason when BOTH contain em dashes", async () => {
    // The genuinely ambiguous case: a dash in each field is what makes the
    // quoting load-bearing, since only the quotes tell a reader where the
    // title ends and the reason begins.
    process.env.TRIAGE_REASONS = "1";
    mockParse.mockResolvedValue({
      parsed_output: {
        verdicts: [
          { index: 0, notable: true, severity: 3, reason: "landmark — not procedural" },
        ],
      },
    });
    const { triageClusters } = await import("@/lib/triage");

    const { lines } = await captureLines(() =>
      triageClusters([makeCluster("US Politics", "Court rules — tariffs struck down")])
    );

    expect(lines).toEqual([
      '[triage] US Politics — PASS (severity 3) — "Court rules — tariffs struck down" — landmark — not procedural',
    ]);
    // The quoted span is what disambiguates; a naive dash split cannot.
    expect(lines[0].match(/"([^"]*)"/)?.[1]).toBe("Court rules — tariffs struck down");
  });
});

// No unit test can validate whether the prompt CALIBRATES well — that only
// comes back from a paid run against real news. What these pin is that the
// clauses the calibration depends on are still present, so a later edit
// can't quietly drop one and leave the failure to be discovered by a $0.35
// measurement.
describe("triage system prompt", () => {
  async function systemPromptSent(): Promise<string> {
    mockParse.mockResolvedValue(verdictsFor(1));
    const { triageClusters } = await import("@/lib/triage");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await triageClusters([makeCluster("Tech/AI", "A story")]);
    vi.mocked(console.log).mockRestore();
    return mockParse.mock.calls[0][0].system as string;
  }

  it("anchors notability to the topic's own typical day", async () => {
    // Matches the anchoring paragraph's own distinctive wording, not the
    // bare phrase "typical day" — that appears in the severity rubric, in
    // the batch paragraph and in the severity clause too, so a substring
    // check on it would survive deleting this paragraph outright.
    expect(await systemPromptSent()).toContain(
      "anchor against that typical-day baseline rather than against other clusters"
    );
  });

  it("keeps the reject-when-torn tiebreaker in both places it has to appear", async () => {
    // Case-insensitively, because the original clause opens a sentence
    // ("When genuinely torn, reject") while the batch restatement below is
    // mid-sentence. Matching case-sensitively here would silently only
    // cover the restatement and duplicate the next test.
    const matches = (await systemPromptSent()).match(/when genuinely torn, reject/gi) ?? [];
    expect(matches).toHaveLength(2);
  });

  it("restates the tiebreaker inside the batch instructions", async () => {
    // The tiebreaker was written when the model saw one cluster per call.
    // Batching moved the judgement into a list context, and the batch
    // paragraph is what has to carry every rule that must survive that
    // context — so the tiebreaker has to appear there, after the paragraph
    // that introduces the batch, not only in its original single-cluster
    // home far above.
    const prompt = await systemPromptSent();
    const batchParagraphStart = prompt.indexOf("You are given several numbered clusters");
    expect(batchParagraphStart).toBeGreaterThan(-1);
    // Deliberately case-sensitive and lowercase: this is the mid-sentence
    // restatement specifically, not the original sentence-opening clause,
    // which lives far above the batch paragraph.
    expect(prompt.indexOf("when genuinely torn, reject", batchParagraphStart)).toBeGreaterThan(
      batchParagraphStart
    );
  });

  it("extends the anti-relative-grading rule to severity, not just pass/reject", async () => {
    // The measured regression moved the severity DISTRIBUTION as well as
    // the pass count, and severity is what the per-topic card cap selects
    // on — so an instruction that only fixes "how many you pass" leaves the
    // half that decides which stories actually survive uncorrected.
    const prompt = await systemPromptSent();
    expect(prompt).toContain("The same applies to severity");
    expect(prompt).toContain("never against the other clusters in front of you");
  });

  it("tells the model most clusters in a batch are not notable", async () => {
    // The base-rate anchor. Without it the model grades the batch against
    // itself and passes some fraction of whatever it is shown, which is what
    // doubled the pass rate when triage was batched.
    const prompt = await systemPromptSent();
    expect(prompt).toContain("Most clusters in a batch are routine");
    expect(prompt).toContain("must not depend on how many you were handed");
  });
});
