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

// NOTHING here touches the filesystem. The suite has zero fs usage and no
// setup file, and the sink's writer is injected precisely so it stays that
// way -- a test that wrote to disk would need both, and would leave real
// files behind on a machine that runs the suite.

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

/** A Supabase client stub — only `.from().insert()` is ever reached. */
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

describe("createJsonlSink", () => {
  it("appends one terminated JSON line to the given path", async () => {
    const append = vi.fn(async () => {});
    const sink = createJsonlSink("/tmp/does-not-exist/runs.jsonl", append);

    await sink(makeRecord());

    expect(append).toHaveBeenCalledTimes(1);
    const [path, contents] = append.mock.calls[0] as unknown as [string, string];
    expect(path).toBe("/tmp/does-not-exist/runs.jsonl");
    expect(contents.endsWith("\n")).toBe(true);
    expect(JSON.parse(contents).runId).toBe("run-1");
  });

  it("writes no user identifier into the local file", async () => {
    const append = vi.fn(async () => {});
    await createJsonlSink("/tmp/x.jsonl", append)(makeRecord());

    const contents = (append.mock.calls[0] as unknown as [string, string])[1];
    expect(contents).not.toContain("user-1");
    expect(JSON.parse(contents)).not.toHaveProperty("userId");
  });

  it("rejects when the write fails, rather than reporting success", async () => {
    // emitUsageRun is what decides to swallow. A sink that hid its own
    // failure would make the two sinks able to disagree with nothing said.
    const append = vi.fn(async () => {
      throw new Error("ENOSPC");
    });

    await expect(createJsonlSink("/tmp/x.jsonl", append)(makeRecord())).rejects.toThrow("ENOSPC");
  });
});

describe("createSupabaseSink", () => {
  it("inserts one snake_case row into usage_runs, user_id included", async () => {
    const insert: InsertMock = vi.fn(async () => ({ error: null }));
    const supabase = stubSupabase(insert);

    await createSupabaseSink(supabase)(makeRecord());

    expect(supabase.from).toHaveBeenCalledWith("usage_runs");
    const row = insert.mock.calls[0][0];
    expect(row.id).toBe("run-1");
    expect(row.user_id).toBe("user-1");
    expect(row.run_shape).toBe("cold");
    expect(row.total_billed_usd).toBeGreaterThan(0);
  });

  it("rejects with the Postgres message when the insert errors", async () => {
    const insert: InsertMock = vi.fn(async () => ({
      error: { message: 'relation "usage_runs" does not exist' },
    }));

    await expect(createSupabaseSink(stubSupabase(insert))(makeRecord())).rejects.toThrow(
      'relation "usage_runs" does not exist'
    );
  });
});

describe("defaultUsageSinks", () => {
  it("includes the local JSONL sink in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(2);
  });

  it("omits the JSONL sink in production", async () => {
    // Vercel's filesystem is read-only outside an ephemeral /tmp. An ungated
    // sink would throw on every production run, be swallowed by emitUsageRun,
    // and leave a file that never appears -- a silent failure by design.
    vi.stubEnv("NODE_ENV", "production");
    const insert: InsertMock = vi.fn(async () => ({ error: null }));
    const supabase = stubSupabase(insert);

    const sinks = defaultUsageSinks(supabase);

    expect(sinks).toHaveLength(1);
    // Asserted by behaviour, not by counting: the one survivor is the
    // Supabase sink, not the JSONL one.
    await sinks[0](makeRecord());
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("omits the JSONL sink under test, so the suite never touches disk", () => {
    // Not hypothetical. The routes are driven end-to-end by nine wiring test
    // files, and while this gate was "anything but production" every vitest
    // run appended real lines to the real notes-logs/cost/runs.jsonl -- 322
    // had piled up, mixing fabricated runs into the file the cost report
    // averages. The gate is an allowlist now for exactly this reason.
    vi.stubEnv("NODE_ENV", "test");
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(1);
  });

  it("omits the JSONL sink in any environment that has not opted in", () => {
    // The denylist's failure was that an unconsidered environment got disk
    // writes by default. An allowlist inverts that.
    for (const env of ["production", "test", "staging", "preview", ""]) {
      vi.stubEnv("NODE_ENV", env);
      expect({ env, sinks: defaultUsageSinks(stubSupabase(vi.fn())).length }).toEqual({
        env,
        sinks: 1,
      });
    }
  });

  it("decides per call, not once at module load", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(1);
    vi.stubEnv("NODE_ENV", "development");
    expect(defaultUsageSinks(stubSupabase(vi.fn()))).toHaveLength(2);
  });
});

describe("emitUsageRun is total", () => {
  it("resolves when a sink rejects", async () => {
    const failing: UsageSink = async () => {
      throw new Error("sink exploded");
    };

    await expect(emitUsageRun([failing], makeRecord())).resolves.toBeUndefined();
  });

  it("resolves when a sink throws synchronously", async () => {
    // A sync throw escapes before any Promise.race can see it, so this is a
    // genuinely different path from a rejected promise.
    const failing = (() => {
      throw new Error("threw before returning a promise");
    }) as unknown as UsageSink;

    await expect(emitUsageRun([failing], makeRecord())).resolves.toBeUndefined();
  });

  it("resolves within the timeout when a sink hangs forever", async () => {
    vi.useFakeTimers();
    const hanging: UsageSink = () => new Promise<void>(() => {});

    const emitted = emitUsageRun([hanging], makeRecord(), 2000);
    let settled = false;
    void emitted.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(emitted).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("says so on the error stream when a sink hangs, rather than going quiet", async () => {
    vi.useFakeTimers();
    const hanging: UsageSink = () => new Promise<void>(() => {});

    const emitted = emitUsageRun([hanging], makeRecord(), 50);
    await vi.advanceTimersByTimeAsync(50);
    await emitted;

    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("did not settle");
  });

  it("says so on the error stream when a sink rejects", async () => {
    const failing: UsageSink = async () => {
      throw new Error("sink exploded");
    };

    await emitUsageRun([failing], makeRecord());

    const logged = vi.mocked(console.error).mock.calls.flat();
    expect(logged.join(" ")).toContain("a usage sink failed");
    expect(logged).toContainEqual(expect.objectContaining({ message: "sink exploded" }));
  });

  it("still runs the other sink when one fails", async () => {
    const failing: UsageSink = async () => {
      throw new Error("sink exploded");
    };
    const healthy = vi.fn(async () => {});

    await emitUsageRun([failing, healthy], makeRecord());

    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("still runs the other sink when one hangs, without waiting for it", async () => {
    vi.useFakeTimers();
    const hanging: UsageSink = () => new Promise<void>(() => {});
    const healthy = vi.fn(async () => {});

    const emitted = emitUsageRun([hanging, healthy], makeRecord(), 2000);
    // The healthy sink is not blocked behind the hanging one.
    await vi.advanceTimersByTimeAsync(0);
    expect(healthy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(emitted).resolves.toBeUndefined();
  });

  it("does not leave a pending timer behind when every sink is fast", async () => {
    vi.useFakeTimers();
    const healthy: UsageSink = async () => {};

    await emitUsageRun([healthy], makeRecord(), 2000);

    // An uncleared timer keeps a serverless function alive for the full
    // window after the work is done, and is billed for.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not raise an unhandled rejection when a timed-out sink rejects later", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectLate: (error: Error) => void = () => {};
      const slowFailure: UsageSink = () =>
        new Promise<void>((_resolve, reject) => {
          rejectLate = reject;
        });

      const emitted = emitUsageRun([slowFailure], makeRecord(), 50);
      await vi.advanceTimersByTimeAsync(50);
      await emitted;

      // The race is long over; the sink only now gives up. Promise.race is
      // what absorbs this today (it attaches handlers to every input), so
      // this test guards the PROPERTY rather than one implementation of it:
      // a hand-rolled timeout that watched only `work`'s fulfilment would
      // leave this rejection unhandled, and inside a Next route an unhandled
      // rejection reads exactly like a pipeline crash.
      rejectLate(new Error("gave up after the timeout"));
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("resolves on an empty sink list", async () => {
    await expect(emitUsageRun([], makeRecord())).resolves.toBeUndefined();
  });
});
