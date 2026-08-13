import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUsageCollector,
  currentUsageCollector,
  recordCall,
  withUsageCollector,
} from "@/lib/usageCollector";
import type { RecordedCall } from "@/lib/usage";

const AT = new Date("2026-08-13T12:00:00Z");

/** A stand-in for what `client.messages.parse` resolves to. */
function response(usage?: unknown) {
  return { parsed_output: { ok: true }, usage };
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

beforeEach(() => {
  // The collector logs one line per call by design; silence it so the suite
  // output stays readable. Assertions here are on recorded state, not logs.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordCall with no collector in scope", () => {
  // This is the contract that keeps ~30 pre-existing lib tests passing
  // unchanged: they call triage/rank/writeCard/etc. directly, outside any
  // request, with mocked responses that have no usage at all.
  it("returns the response untouched and records nothing", async () => {
    // A collector exists but its scope is never entered — so this genuinely
    // asserts nothing leaked into it, rather than just observing that no
    // collector is active (which would be true however recordCall behaved).
    const unentered = createUsageCollector(AT);
    const res = response(USAGE);

    await expect(recordCall("triage", "claude-haiku-4-5", async () => res)).resolves.toBe(res);

    expect(currentUsageCollector()).toBeUndefined();
    expect(unentered.calls()).toEqual([]);
  });

  it("propagates a throw unchanged", async () => {
    const boom = new Error("upstream failed");
    await expect(
      recordCall("triage", "claude-haiku-4-5", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });
});

describe("recordCall inside a collector scope", () => {
  it("records the response's usage against the given stage and model", async () => {
    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () =>
      recordCall("triage", "claude-haiku-4-5", async () => response(USAGE))
    );

    expect(collector.calls()).toEqual([
      {
        stage: "triage",
        model: "claude-haiku-4-5",
        tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  it("still returns the response unchanged", async () => {
    const collector = createUsageCollector(AT);
    const res = response(USAGE);
    const returned = await withUsageCollector(collector, () =>
      recordCall("writeCard", "claude-sonnet-5", async () => res)
    );
    expect(returned).toBe(res);
  });

  it("counts a response with no usage as billed-but-unmeasured", async () => {
    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () =>
      recordCall("triage", "claude-haiku-4-5", async () => response(undefined))
    );

    const summary = collector.summarize();
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalCallsWithoutUsage).toBe(1);
  });

  it("counts a throwing call and rethrows it unchanged", async () => {
    // messages.parse validates against a zod schema *after* a billed 200, so
    // a throw does not mean the call was free. Recording it is what lets the
    // summary label its totals a floor.
    const collector = createUsageCollector(AT);
    const boom = new Error("schema mismatch");

    await expect(
      withUsageCollector(collector, () =>
        recordCall("writeCard", "claude-sonnet-5", async () => {
          throw boom;
        })
      )
    ).rejects.toBe(boom);

    expect(collector.calls()).toEqual([
      { stage: "writeCard", model: "claude-sonnet-5", tokens: null },
    ]);
  });

  it("tolerates a non-object response", async () => {
    // `R extends object` rules this out at compile time; the cast is here to
    // prove the runtime guard behind it still holds if the type is bypassed.
    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () =>
      recordCall("rank", "claude-haiku-4-5", async () => "not an object" as unknown as object)
    );
    expect(collector.summarize().totalCallsWithoutUsage).toBe(1);
  });

  // If reading usage could throw, the call would vanish from the record
  // entirely — not even counted as billed-but-unknown — which is invisible
  // to the FLOOR warning that exists to catch exactly this.
  it("still counts a call whose usage cannot be read at all", async () => {
    const collector = createUsageCollector(AT);
    const hostile = {
      get usage(): unknown {
        throw new Error("unreadable");
      },
    };

    await expect(
      withUsageCollector(collector, () =>
        recordCall("writeCard", "claude-sonnet-5", async () => hostile)
      )
    ).resolves.toBe(hostile);

    expect(collector.calls()).toEqual([
      { stage: "writeCard", model: "claude-sonnet-5", tokens: null },
    ]);
  });
});

describe("scope propagation", () => {
  // The triage and dedup stages fan out over an unbounded Promise.all, so
  // every one of those concurrent children has to land in the right run.
  it("attributes a concurrent fan-out to the enclosing collector", async () => {
    const collector = createUsageCollector(AT);

    await withUsageCollector(collector, () =>
      Promise.all(
        Array.from({ length: 20 }, () =>
          recordCall("triage", "claude-haiku-4-5", async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            return response(USAGE);
          })
        )
      )
    );

    expect(collector.calls()).toHaveLength(20);
    expect(collector.summarize().totalTokens.inputTokens).toBe(2000);
  });

  it("survives nested awaits and intermediate helper functions", async () => {
    const collector = createUsageCollector(AT);

    const deep = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return recordCall("dedup", "claude-haiku-4-5", async () => response(USAGE));
    };

    await withUsageCollector(collector, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await deep();
    });

    expect(collector.calls()).toHaveLength(1);
    expect(collector.calls()[0].stage).toBe("dedup");
  });

  // A module-level singleton collector would fail this outright — two users
  // generating digests at once would have their spend merged into one bill.
  it("keeps two concurrent runs isolated from each other", async () => {
    const first = createUsageCollector(AT);
    const second = createUsageCollector(AT);

    const run = (collector: ReturnType<typeof createUsageCollector>, count: number) =>
      withUsageCollector(collector, async () => {
        for (let i = 0; i < count; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await recordCall("triage", "claude-haiku-4-5", async () => response(USAGE));
        }
      });

    await Promise.all([run(first, 3), run(second, 5)]);

    expect(first.calls()).toHaveLength(3);
    expect(second.calls()).toHaveLength(5);
  });

  it("exposes the active collector, and nothing once the scope exits", async () => {
    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, async () => {
      expect(currentUsageCollector()).toBe(collector);
    });
    expect(currentUsageCollector()).toBeUndefined();
  });
});

describe("collector reporting", () => {
  it("logs one line per recorded call", async () => {
    const logged = vi.mocked(console.log);
    const collector = createUsageCollector(AT);

    await withUsageCollector(collector, () =>
      recordCall("triage", "claude-haiku-4-5", async () => response(USAGE))
    );

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toContain("[usage] triage claude-haiku-4-5 in=100 out=20");
  });

  // `add` runs inside recordCall, on a billed call's return path. A throw
  // from the log would propagate as if the Claude call itself had failed —
  // dropping a card in the digest pipeline, or turning a successful expand
  // into a 502. Instrumentation must not be able to break what it measures.
  it("survives a logging failure without disturbing the call it is measuring", async () => {
    vi.mocked(console.log).mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    const collector = createUsageCollector(AT);
    const res = response(USAGE);

    await expect(
      withUsageCollector(collector, () =>
        recordCall("writeCard", "claude-sonnet-5", async () => res)
      )
    ).resolves.toBe(res);

    // The record still lands, so the run's totals survive the lost line.
    expect(collector.calls()).toHaveLength(1);
    expect(collector.summarize().totalTokens.inputTokens).toBe(100);
  });

  it("prices the whole run at the collector's fixed instant", () => {
    // Fixing `at` per run means a generation spanning the day a promo lapses
    // can't be priced half one way and half the other.
    const collector = createUsageCollector(new Date("2026-09-01T00:00:00Z"));
    collector.add({
      stage: "writeCard",
      model: "claude-sonnet-5",
      tokens: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    const summary = collector.summarize();
    expect(summary.promos[0].applied).toBe(false);
    expect(summary.totalBilledUsd).toBe(summary.totalListUsd);
  });

  it("hands out a copy of its records, not its live array", () => {
    const collector = createUsageCollector(AT);
    collector.add({ stage: "rank", model: "claude-haiku-4-5", tokens: null });

    (collector.calls() as RecordedCall[]).length = 0;

    expect(collector.calls()).toHaveLength(1);
  });

  // A shallow array copy alone isn't enough: the tokens objects inside it
  // are the same ones backing the totals, so mutating one would rewrite a
  // run's spend. Freezing on the way in closes that.
  it("does not let a consumer rewrite a recorded call's tokens", async () => {
    const collector = createUsageCollector(AT);
    await withUsageCollector(collector, () =>
      recordCall("triage", "claude-haiku-4-5", async () => response(USAGE))
    );

    const snapshot = collector.calls() as RecordedCall[];
    expect(() => {
      snapshot[0].tokens!.inputTokens = 999_999;
    }).toThrow(TypeError);

    expect(collector.summarize().totalTokens.inputTokens).toBe(100);
  });

  // Freezing what the caller handed over would reach back out of the
  // collector and mutate something they still own — and a shared or reused
  // CallTokens (ZERO_TOKENS is exported) would become frozen for every other
  // holder of it, from one collector's add().
  it("does not freeze the caller's own objects", () => {
    const collector = createUsageCollector(AT);
    const mine: RecordedCall = {
      stage: "rank",
      model: "claude-haiku-4-5",
      tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };

    collector.add(mine);

    expect(Object.isFrozen(mine)).toBe(false);
    expect(Object.isFrozen(mine.tokens)).toBe(false);
    // ...and mutating it afterwards must not rewrite what was recorded.
    mine.tokens!.inputTokens = 999_999;
    expect(collector.summarize().totalTokens.inputTokens).toBe(1);
  });

  // Same guarantee as `add`, but at the run's exit: in the digest route
  // `report` runs in the generator's finally, just before the generation
  // mutex is released. A throw escaping here could strand that mutex and
  // lock the user out of generating again.
  it("does not throw out of report() when logging fails", () => {
    const collector = createUsageCollector(AT);
    collector.add({ stage: "rank", model: "claude-haiku-4-5", tokens: null });
    vi.mocked(console.log).mockImplementation(() => {
      throw new Error("stdout is gone");
    });

    expect(() => collector.report({ label: "digest complete" })).not.toThrow();
  });

  it("emits the summary table through report()", () => {
    const logged = vi.mocked(console.log);
    const collector = createUsageCollector(AT);
    collector.add({
      stage: "triage",
      model: "claude-haiku-4-5",
      tokens: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    logged.mockClear();

    collector.report({ label: "digest complete" });

    const text = logged.mock.calls.map((call) => call[0]).join("\n");
    expect(text).toContain("digest complete — 1 calls");
    expect(text).toContain("TOTAL");
  });
});
