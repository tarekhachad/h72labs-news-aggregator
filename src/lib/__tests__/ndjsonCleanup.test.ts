import { afterEach, describe, expect, it, vi } from "vitest";
import { DIGEST_FAILED_MESSAGE, toNdjsonStream } from "@/lib/ndjsonStream";

// The generator's finally is where the spend reservation is settled and the
// generation claim released. Two exits used to skip or mishandle it: an event
// the stream can't serialise (the generator stays paused at its yield, so the
// finally never runs), and a finally that throws after a mid-stream cancel
// (nothing handled the rejection).

type Event = { stage: string; [key: string]: unknown };

const PIPELINE_FAILED = "[digest] pipeline failed:";
const FAILED_RUN_CLEANUP = "[digest] cleanup after a failed run threw:";
const DISCONNECT_CLEANUP = "[digest] cleanup after a client disconnect threw:";
const ERROR_LINE = `{"stage":"error","message":"${DIGEST_FAILED_MESSAGE}"}\n`;

function circular(): Event {
  const event: Event = { stage: "writing" };
  event.self = event;
  return event;
}

/** Collects unhandled rejections for the duration of `body`. */
async function watchUnhandled(body: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toNdjsonStream: an event JSON.stringify can't serialise", () => {
  it.each([
    ["a BigInt", { stage: "ingesting", count: BigInt(1) }],
    ["a circular object", circular()],
  ])("with %s, runs the generator's finally once and sends the fixed error event", async (_label, bad) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log: string[] = [];
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "started" };
        yield bad as Event;
        log.push("resumed past the bad event");
      } finally {
        log.push("finally");
      }
    })();

    const text = await new Response(toNdjsonStream(events, async () => {})).text();

    expect(text).toBe(`{"stage":"started"}\n${ERROR_LINE}`);
    // Resumed to return, not to carry on: nothing after the yield ran.
    expect(log).toEqual(["finally"]);
    expect(error).toHaveBeenCalledWith(PIPELINE_FAILED, expect.any(TypeError));
  });

  it("ends the response only after the finally has finished its async cleanup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const log: string[] = [];
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting", count: BigInt(1) };
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.push("claim released");
      }
    })();

    const text = await new Response(toNdjsonStream(events, async () => {})).text();

    expect(text).toBe(ERROR_LINE);
    expect(log).toEqual(["claim released"]);
  });

  it("still sends the error event and closes when the finally itself throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanupError = new Error("release_generation failed");
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting", count: BigInt(1) };
      } finally {
        throw cleanupError;
      }
    })();

    let text = "";
    const unhandled = await watchUnhandled(async () => {
      text = await new Response(toNdjsonStream(events, async () => {})).text();
    });

    expect(text).toBe(ERROR_LINE);
    expect(error).toHaveBeenCalledWith(FAILED_RUN_CLEANUP, cleanupError);
    expect(unhandled).toEqual([]);
  });

  it("still sends the error event when the console is dead too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console is dead");
    });
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting", count: BigInt(1) };
      } finally {
        finallyRuns += 1;
      }
    })();

    const text = await new Response(toNdjsonStream(events, async () => {})).text();

    expect(text).toBe(ERROR_LINE);
    expect(finallyRuns).toBe(1);
  });

  it("leaves a real pipeline failure as it was: one finally, one error event, no cleanup log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting" };
        throw new Error("triage blew up");
      } finally {
        finallyRuns += 1;
      }
    })();

    const text = await new Response(toNdjsonStream(events, async () => {})).text();

    expect(text).toBe(`{"stage":"ingesting"}\n${ERROR_LINE}`);
    expect(finallyRuns).toBe(1);
    expect(error.mock.calls.map(([first]) => first)).toEqual([PIPELINE_FAILED]);
  });
});

describe("toNdjsonStream: a finally that throws after a mid-stream cancel", () => {
  /** A pipeline paused mid-stage, whose finally throws once it runs. */
  function throwingCleanupPipeline(cleanupError: Error) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => (markInFlight = resolve));
    const state = { finallyRuns: 0 };
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting" };
        markInFlight();
        await gate;
        yield { stage: "clustering" };
      } finally {
        state.finallyRuns += 1;
        throw cleanupError;
      }
    })();
    return { events, release, inFlight, state };
  }

  it("raises no unhandled rejection and logs the cleanup failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanupError = new Error("settle_spend failed");
    const { events, release, inFlight, state } = throwingCleanupPipeline(cleanupError);

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(events, async () => {}).getReader();
      await reader.read();
      await inFlight;
      // Resolves while the stage is still in flight: cancel() does not wait on it.
      await reader.cancel();
      release();
      await vi.waitFor(() => expect(state.finallyRuns).toBe(1));
    });

    expect(unhandled).toEqual([]);
    expect(error).toHaveBeenCalledWith(DISCONNECT_CLEANUP, cleanupError);
  });

  it("raises no unhandled rejection when the console is dead too", async () => {
    const error = vi.fn(() => {
      throw new Error("console is dead");
    });
    vi.spyOn(console, "error").mockImplementation(error);
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console is dead");
    });
    const cleanupError = new Error("settle_spend failed");
    const { events, release, inFlight, state } = throwingCleanupPipeline(cleanupError);

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(events, async () => {}).getReader();
      await reader.read();
      await inFlight;
      await reader.cancel();
      release();
      await vi.waitFor(() => expect(state.finallyRuns).toBe(1));
    });

    expect(unhandled).toEqual([]);
    expect(error).toHaveBeenCalledWith(DISCONNECT_CLEANUP, cleanupError);
  });
});
