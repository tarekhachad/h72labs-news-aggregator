import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeUsage, type RecordedCall } from "@/lib/usage";
import { buildUsageRunRecord, type UsageRunContext, type UsageRunRecord } from "@/lib/usageRecord";
import {
  createJsonlSink,
  createSupabaseSink,
  defaultUsageSinks,
  emitUsageRun,
  type UsageSink,
} from "@/lib/usageSinks";

// Adversarial probes on top of usageSinks.test.ts's coverage: concurrent /
// interleaved emitUsageRun calls, timer leakage under mixed fast/slow/failing
// sinks, awkward-timing races between resolve/reject and the timeout, and
// NODE_ENV edge values defaultUsageSinks was not explicitly tested against.
//
// Zero filesystem usage, same as the base suite -- the JSONL writer stays
// injected throughout.

const AT = new Date("2026-09-11T12:00:00Z");

const CALLS: RecordedCall[] = [
  {
    stage: "triage",
    model: "claude-haiku-4-5",
    tokens: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

function makeRecord(overrides: Partial<UsageRunContext> = {}): UsageRunRecord {
  const context: UsageRunContext = {
    userId: "user-1",
    route: "digest",
    digestId: "digest-1",
    cardId: null,
    outcome: "complete",
    label: "digest complete",
    runShape: "cold",
    topicCount: 2,
    sourceCount: 3,
    articleCount: 40,
    clusterCount: 12,
    clustersAfterDedup: 12,
    notableCount: 4,
    cardsDroppedByCap: 0,
    cardsWritten: 4,
    cardsFailed: 0,
    rankApplied: true,
    expectedCalls: { triage: 1 },
    ...overrides,
  };
  return buildUsageRunRecord(summarizeUsage(CALLS, AT), context, AT, "run-1");
}

type InsertMock = ReturnType<typeof vi.fn<(row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>>>;

function stubSupabase(insert: InsertMock): SupabaseClient {
  return { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("emitUsageRun: concurrent / interleaved calls", () => {
  it("two concurrent emitUsageRun calls do not cross-deliver records to each other's sinks", async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const sinkA: UsageSink = async (record) => {
      seenA.push(record.runId);
    };
    const sinkB: UsageSink = async (record) => {
      seenB.push(record.runId);
    };

    const recordA = makeRecord({ digestId: "digest-A" });
    const recordB = makeRecord({ digestId: "digest-B" });
    // buildUsageRunRecord doesn't set runId from context, so give them
    // distinct runIds directly via a second build.
    const runA = { ...recordA, runId: "run-A" };
    const runB = { ...recordB, runId: "run-B" };

    await Promise.all([emitUsageRun([sinkA], runA), emitUsageRun([sinkB], runB)]);

    expect(seenA).toEqual(["run-A"]);
    expect(seenB).toEqual(["run-B"]);
  });

  it("a hang in one interleaved call's sink does not delay or corrupt a concurrent call using a separate timeout", async () => {
    vi.useFakeTimers();
    const hanging: UsageSink = () => new Promise<void>(() => {});
    const fastSeen: string[] = [];
    const fast: UsageSink = async (record) => {
      fastSeen.push(record.runId);
    };

    const slowRun = { ...makeRecord(), runId: "slow" };
    const fastRun = { ...makeRecord(), runId: "fast" };

    const slow = emitUsageRun([hanging], slowRun, 2000);
    const quick = emitUsageRun([fast], fastRun, 2000);

    // The fast call's own sink resolves on a microtask; it must not need the
    // slow call's 2000ms timer to elapse first.
    await vi.advanceTimersByTimeAsync(0);
    await quick;
    expect(fastSeen).toEqual(["fast"]);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(slow).resolves.toBeUndefined();
  });

  it("many interleaved emitUsageRun calls with independently-timed sinks all settle and each fires its own sink exactly once", async () => {
    vi.useFakeTimers();
    const counts = new Map<string, number>();
    function countingSink(id: string, delayMs: number): UsageSink {
      return () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            counts.set(id, (counts.get(id) ?? 0) + 1);
            resolve();
          }, delayMs);
        });
    }

    const runs = [0, 1, 2, 3, 4].map((i) =>
      emitUsageRun([countingSink(`sink-${i}`, i * 100)], { ...makeRecord(), runId: `run-${i}` }, 2000)
    );

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(runs);

    for (let i = 0; i < 5; i++) {
      expect(counts.get(`sink-${i}`)).toBe(1);
    }
  });
});

describe("emitUsageRun: timer leakage under mixed conditions", () => {
  it("clears every timer when sinks are a mix of fast-resolve, fast-reject and sync-throw", async () => {
    vi.useFakeTimers();
    const resolving: UsageSink = async () => {};
    const rejecting: UsageSink = async () => {
      throw new Error("boom");
    };
    const throwingSync = (() => {
      throw new Error("sync boom");
    }) as unknown as UsageSink;

    await emitUsageRun([resolving, rejecting, throwingSync], makeRecord(), 2000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer for a sink that hangs and is then abandoned, leaving none pending after settlement", async () => {
    vi.useFakeTimers();
    const hanging: UsageSink = () => new Promise<void>(() => {});

    const emitted = emitUsageRun([hanging], makeRecord(), 100);
    await vi.advanceTimersByTimeAsync(100);
    await emitted;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leak a timer per sink when N sinks all hang simultaneously", async () => {
    vi.useFakeTimers();
    const hangA: UsageSink = () => new Promise<void>(() => {});
    const hangB: UsageSink = () => new Promise<void>(() => {});
    const hangC: UsageSink = () => new Promise<void>(() => {});

    const emitted = emitUsageRun([hangA, hangB, hangC], makeRecord(), 500);
    expect(vi.getTimerCount()).toBe(3); // one per sink while pending

    await vi.advanceTimersByTimeAsync(500);
    await emitted;

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("emitUsageRun: awkward timing relative to the timeout", () => {
  it("a sink resolving in the exact same tick the timeout fires still counts as success, not timeout", async () => {
    vi.useFakeTimers();
    let resolveSink: () => void = () => {};
    const sink: UsageSink = () =>
      new Promise<void>((resolve) => {
        resolveSink = resolve;
      });

    const emitted = emitUsageRun([sink], makeRecord(), 100);

    // Resolve the sink and advance the timer to expiry in the same batch --
    // Promise.race resolves on whichever settled promise's .then callback
    // the microtask queue reaches first once both are eligible. Resolving
    // BEFORE advancing the timer should win the race deterministically.
    resolveSink();
    await vi.advanceTimersByTimeAsync(100);
    await expect(emitted).resolves.toBeUndefined();

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).not.toContain("did not settle");
  });

  it("a sink that rejects one tick before the timeout is reported as a failure, not a timeout", async () => {
    vi.useFakeTimers();
    const sink: UsageSink = () =>
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late failure")), 99);
      });

    const emitted = emitUsageRun([sink], makeRecord(), 100);
    await vi.advanceTimersByTimeAsync(100);
    await emitted;

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("a usage sink failed");
    expect(logged).not.toContain("did not settle");
  });

  it("a sink that resolves exactly at timeoutMs via its own internal setTimeout still wins over the timeout (scheduled first)", async () => {
    vi.useFakeTimers();
    const sink: UsageSink = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });

    const emitted = emitUsageRun([sink], makeRecord(), 100);
    await vi.advanceTimersByTimeAsync(100);
    await emitted;

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    // Documenting actual behaviour at an exact tie: the sink's own timer was
    // scheduled (inside runOneSink, sink invoked before the race's own
    // setTimeout) fractionally earlier in registration order, so a same-ms
    // internal timer fires first. This is not a hard guarantee this test
    // should over-claim -- it pins today's actual outcome so a change in
    // ordering is visible rather than silently accepted.
    expect(logged).not.toContain("did not settle");
  });

  it("timeoutMs = 0 still resolves and reports every sink as timed out rather than hanging", async () => {
    vi.useFakeTimers();
    const neverResolves: UsageSink = () => new Promise<void>(() => {});

    const emitted = emitUsageRun([neverResolves], makeRecord(), 0);
    await vi.advanceTimersByTimeAsync(0);
    await expect(emitted).resolves.toBeUndefined();

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("did not settle");
  });

  it("a negative timeoutMs behaves like an immediate timeout rather than throwing or hanging", async () => {
    vi.useFakeTimers();
    const neverResolves: UsageSink = () => new Promise<void>(() => {});

    const emitted = emitUsageRun([neverResolves], makeRecord(), -50);
    await vi.advanceTimersByTimeAsync(0);
    await expect(emitted).resolves.toBeUndefined();
  });
});

describe("createSupabaseSink: adversarial", () => {
  it("rejects when the insert call itself throws synchronously (not just when it returns an error)", async () => {
    const insert = vi.fn(() => {
      throw new Error("network stack exploded");
    }) as unknown as InsertMock;

    await expect(createSupabaseSink(stubSupabase(insert))(makeRecord())).rejects.toThrow(
      "network stack exploded"
    );
  });

  it("propagates through emitUsageRun's swallow without special-casing a throw vs a rejection", async () => {
    const throwingSink = createSupabaseSink(
      stubSupabase(vi.fn(() => Promise.reject(new Error("pg down"))) as unknown as InsertMock)
    );

    await expect(emitUsageRun([throwingSink], makeRecord())).resolves.toBeUndefined();
    const logged = vi.mocked(console.error).mock.calls.flat();
    expect(logged.join(" ")).toContain("a usage sink failed");
  });
});

describe("defaultUsageSinks: NODE_ENV edge values", () => {
  // REWRITTEN when the gate changed from a denylist ("anything but
  // production") to an allowlist ("development only"), so these assertions
  // are inverted from what they were.
  //
  // Worth recording why, because this file originally pinned the bug. One of
  // these cases used to be named "includes JSONL for 'test', the value vitest
  // itself typically runs under" -- it asserted, correctly for the code at
  // the time, that running the suite writes to the real cost file. Once the
  // routes were wired, that stopped being a curiosity and became 322 lines of
  // fabricated test runs sitting in the file the cost report computes its
  // averages from, plus a suite that needs a writable disk.
  //
  // The lesson the allowlist encodes: a denylist silently grants the default
  // to every environment nobody thought about, and "test" was one of them.
  it("omits the JSONL sink for an empty-string NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "");
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(1);
  });

  it("omits the JSONL sink when NODE_ENV is undefined", () => {
    vi.stubEnv("NODE_ENV", undefined as unknown as string);
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(1);
  });

  it("is case-sensitive: 'Development' (capitalized) does not opt in", () => {
    // Under an allowlist, a near-miss fails CLOSED -- no disk write -- which
    // is the safe direction. Under the old denylist the same near-miss on
    // 'Production' failed OPEN and enabled one.
    vi.stubEnv("NODE_ENV", "Development");
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(1);
  });

  it("omits JSONL for 'test', the value vitest itself runs under", () => {
    // The case that matters most: this is the value in effect for every run
    // of this suite, including the nine wiring files that drive the real
    // routes end to end.
    vi.stubEnv("NODE_ENV", "test");
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(1);
  });

  it("includes JSONL for exactly one value: 'development'", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(2);
  });
});

describe("createJsonlSink: default parameter wiring", () => {
  it("uses appendCreatingDir (the real fs-touching default) when no append fn is injected -- verified WITHOUT invoking it", () => {
    // This suite must never touch disk. We only assert createJsonlSink()
    // with no second argument returns a callable sink -- we do not call it,
    // since doing so would hit the real filesystem via the default
    // `appendCreatingDir`. The invocation-side behaviour of the injected
    // path is already covered by the base suite.
    const sink = createJsonlSink();
    expect(typeof sink).toBe("function");
  });
});

describe("emitUsageRun: sync-throw is reported as a sink failure, not plumbing failure", () => {
  it("names a synchronously-throwing sink as failed (not as 'could not be run at all', which is reserved for this function's own machinery)", async () => {
    const throwing = (() => {
      throw new Error("threw before returning a promise");
    }) as unknown as UsageSink;

    await emitUsageRun([throwing], makeRecord());

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("a usage sink failed");
    expect(logged).not.toContain("could not be run at all");
  });
});
