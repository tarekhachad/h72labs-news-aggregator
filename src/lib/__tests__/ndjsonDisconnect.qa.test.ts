import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toNdjsonStream } from "@/lib/ndjsonStream";

type Event = { stage: string } & Record<string, unknown>;

const PIPELINE_FAILED = "[digest] pipeline failed:";
const DISCONNECTED = "[digest] client disconnected mid-stream; stopped sending events";

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

function spyConsole() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  };
}

function pipelineFailedCount(spy: ReturnType<typeof spyConsole>["error"]) {
  return spy.mock.calls.filter(([first]) => first === PIPELINE_FAILED).length;
}

function disconnectCount(spy: ReturnType<typeof spyConsole>["warn"]) {
  return spy.mock.calls.filter(([first]) => first === DISCONNECTED).length;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every queued microtask and one macrotask turn run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(async () => {
  await settle();
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  expect(unhandled).toEqual([]);
});

describe("toNdjsonStream disconnect handling (QA)", () => {
  it("cancel before the first pull logs neither a disconnect nor a failure", async () => {
    const spy = spyConsole();
    const log: string[] = [];
    const events = (async function* (): AsyncGenerator<Event> {
      log.push("body");
      try {
        yield { stage: "ingesting" };
      } finally {
        log.push("finally");
      }
    })();
    const cleanup = vi.fn(async () => {
      log.push("cleanup");
    });

    await toNdjsonStream(events, cleanup).cancel();
    await settle();

    expect(log).toEqual(["cleanup"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(disconnectCount(spy.warn)).toBe(0);
    expect(pipelineFailedCount(spy.error)).toBe(0);
  });

  it("cancel while the generator is idle at a yield (no pull in flight) is silent and runs finally once", async () => {
    const spy = spyConsole();
    const log: string[] = [];
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting" };
        yield { stage: "clustering" };
        yield { stage: "done" };
      } finally {
        log.push("finally");
      }
    })();
    const cleanup = vi.fn(async () => {});
    const stream = toNdjsonStream(events, cleanup);
    // Let the automatic first pull fill the queue (highWaterMark 1), so no
    // second pull is running when the cancel lands.
    await settle();

    await stream.cancel();
    await settle();

    expect(log).toEqual(["finally"]);
    expect(cleanup).not.toHaveBeenCalled();
    expect(disconnectCount(spy.warn)).toBe(0);
    expect(pipelineFailedCount(spy.error)).toBe(0);
  });

  it("disconnect while the done branch awaits events.return(): warns, finally runs once, no failure log", async () => {
    const spy = spyConsole();
    const finallyStarted = deferred();
    const finallyGate = deferred();
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting" };
        yield { stage: "done" };
      } finally {
        finallyRuns += 1;
        finallyStarted.resolve();
        // Stands in for settleThenRelease's database round-trips.
        await finallyGate.promise;
      }
    })();
    const reader = toNdjsonStream(events, async () => {}).getReader();

    expect((await reader.read()).value).toBeDefined(); // ingesting
    await finallyStarted.promise; // done enqueued; pull is awaiting events.return()
    await reader.cancel(); // browser leaves while the claim is being released
    finallyGate.resolve();

    await vi.waitFor(() => expect(disconnectCount(spy.warn)).toBe(1));
    expect(pipelineFailedCount(spy.error)).toBe(0);
    expect(finallyRuns).toBe(1);
  });

  it("a finally that throws during the done branch's events.return() is a pipeline failure even after a disconnect", async () => {
    const spy = spyConsole();
    const finallyStarted = deferred();
    const finallyGate = deferred();
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting" };
        yield { stage: "done" };
      } finally {
        finallyRuns += 1;
        finallyStarted.resolve();
        await finallyGate.promise;
        throw new Error("release_generation_claim failed");
      }
    })();
    const reader = toNdjsonStream(events, async () => {}).getReader();

    await reader.read();
    await finallyStarted.promise;
    await reader.cancel();
    finallyGate.resolve();

    await vi.waitFor(() => expect(pipelineFailedCount(spy.error)).toBe(1));
    expect(disconnectCount(spy.warn)).toBe(0);
    expect(finallyRuns).toBe(1);
  });

  it("an event that cannot be serialised after a disconnect is a pipeline failure, not a disconnect", async () => {
    const spy = spyConsole();
    const inFlight = deferred();
    const gate = deferred();
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting" };
        inFlight.resolve();
        await gate.promise;
        yield { stage: "writing", bad: BigInt(1) };
      } finally {
        finallyRuns += 1;
      }
    })();
    const reader = toNdjsonStream(events, async () => {}).getReader();

    await reader.read();
    await inFlight.promise;
    await reader.cancel();
    gate.resolve();

    await vi.waitFor(() => expect(pipelineFailedCount(spy.error)).toBe(1));
    expect(disconnectCount(spy.warn)).toBe(0);
    await vi.waitFor(() => expect(finallyRuns).toBe(1));
  });

  it("disconnect while the in-flight stage finishes the generator (done: true) warns once and runs finally once", async () => {
    const spy = spyConsole();
    const inFlight = deferred();
    const gate = deferred();
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting" };
        inFlight.resolve();
        await gate.promise;
        // returns without a done event: next() resolves { done: true }
      } finally {
        finallyRuns += 1;
      }
    })();
    const reader = toNdjsonStream(events, async () => {}).getReader();

    await reader.read();
    await inFlight.promise;
    await reader.cancel();
    gate.resolve();

    await vi.waitFor(() => expect(disconnectCount(spy.warn)).toBe(1));
    expect(pipelineFailedCount(spy.error)).toBe(0);
    expect(finallyRuns).toBe(1);
  });

  // Cancels at every point from "before the first pull" through "after the
  // done event", with real async gaps between stages, and checks the
  // invariants that must hold whatever the interleaving.
  it.each(Array.from({ length: 16 }, (_, k) => k))(
    "cancel after %i turns: finally/cleanup exactly once, never a failure log, no unhandled rejection",
    async (turns) => {
      const spy = spyConsole();
      let bodyStarted = false;
      let finallyRuns = 0;
      const events = (async function* (): AsyncGenerator<Event> {
        bodyStarted = true;
        try {
          yield { stage: "ingesting" };
          await settle();
          yield { stage: "clustering" };
          await Promise.resolve();
          yield { stage: "triaging" };
          await settle();
          yield { stage: "done" };
        } finally {
          finallyRuns += 1;
        }
      })();
      const cleanup = vi.fn(async () => {});
      const reader = toNdjsonStream(events, cleanup).getReader();
      // Keep reading in the background so pulls actually happen.
      const drained = (async () => {
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) return;
          }
        } catch {
          // a cancelled reader may reject a pending read; that's fine
        }
      })();

      for (let i = 0; i < turns; i += 1) {
        if (i % 2 === 0) await Promise.resolve();
        else await settle();
      }
      await reader.cancel().catch(() => {});
      await drained;
      await settle();
      await settle();

      expect(pipelineFailedCount(spy.error)).toBe(0);
      expect(spy.error).not.toHaveBeenCalled();
      expect(disconnectCount(spy.warn)).toBeLessThanOrEqual(1);
      if (bodyStarted) {
        expect(finallyRuns).toBe(1);
        expect(cleanup).not.toHaveBeenCalled();
      } else {
        expect(finallyRuns).toBe(0);
        expect(cleanup).toHaveBeenCalledTimes(1);
      }
    },
  );
});
