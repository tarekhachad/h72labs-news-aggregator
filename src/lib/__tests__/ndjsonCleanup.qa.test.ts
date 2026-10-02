import { afterEach, describe, expect, it, vi } from "vitest";
import { DIGEST_FAILED_MESSAGE, toNdjsonStream } from "@/lib/ndjsonStream";

// QA gap tests: orderings between cancel() and the catch path's
// events.return(), and the done branch's return throwing.

type Event = { stage: string; [key: string]: unknown };

const PIPELINE_FAILED = "[digest] pipeline failed:";
const FAILED_RUN_CLEANUP = "[digest] cleanup after a failed run threw:";
const DISCONNECT_CLEANUP = "[digest] cleanup after a client disconnect threw:";
const DISCONNECT_WARN = "[digest] client disconnected mid-stream; stopped sending events";
const ERROR_LINE = `{"stage":"error","message":"${DIGEST_FAILED_MESSAGE}"}\n`;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function watchUnhandled(body: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return unhandled;
}

const decoder = new TextDecoder();
const firstArgs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([first]) => first);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cancel arriving while pull is awaiting the catch path's cleanup return", () => {
  it("runs the finally once, does not hold cancel open on it, and leaves nothing unhandled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const finallyEntered = deferred();
    const finallyGate = deferred();
    const state = { finallyRuns: 0, finallyDone: false };
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting", count: BigInt(1) };
      } finally {
        state.finallyRuns += 1;
        finallyEntered.resolve();
        await finallyGate.promise;
        state.finallyDone = true;
      }
    })();

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(events, async () => {}).getReader();
      const first = await reader.read();
      expect(decoder.decode(first.value)).toBe(ERROR_LINE);
      await finallyEntered.promise;
      // pull is now parked on `await events.return()`; the client goes away.
      await reader.cancel();
      expect(state.finallyDone).toBe(false);
      finallyGate.resolve();
      await vi.waitFor(() => expect(state.finallyDone).toBe(true));
    });

    expect(unhandled).toEqual([]);
    expect(state.finallyRuns).toBe(1);
    expect(firstArgs(error)).toEqual([PIPELINE_FAILED]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a throwing finally once, as the failed-run cleanup, when cancel lands mid-cleanup", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cleanupError = new Error("release_generation failed");
    const finallyEntered = deferred();
    const finallyGate = deferred();
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "ingesting", count: BigInt(1) };
      } finally {
        finallyRuns += 1;
        finallyEntered.resolve();
        await finallyGate.promise;
        throw cleanupError;
      }
    })();

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(events, async () => {}).getReader();
      await reader.read();
      await finallyEntered.promise;
      await reader.cancel();
      finallyGate.resolve();
      await vi.waitFor(() => expect(firstArgs(error)).toContain(FAILED_RUN_CLEANUP));
    });

    expect(unhandled).toEqual([]);
    expect(finallyRuns).toBe(1);
    expect(firstArgs(error)).toEqual([PIPELINE_FAILED, FAILED_RUN_CLEANUP]);
  });
});

describe("cancel during an in-flight stage that then yields an unserialisable event", () => {
  function pipelineWithGate(finallyBody: () => void | Promise<void>) {
    const gate = deferred();
    const inFlight = deferred();
    const state = { finallyRuns: 0, resumedPastBadEvent: false };
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "started" };
        inFlight.resolve();
        await gate.promise;
        yield { stage: "clustering", count: BigInt(1) };
        state.resumedPastBadEvent = true;
        yield { stage: "done" };
      } finally {
        state.finallyRuns += 1;
        await finallyBody();
      }
    })();
    return { events, gate, inFlight, state };
  }

  it("runs the finally exactly once and raises nothing unhandled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { events, gate, inFlight, state } = pipelineWithGate(() => {});

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(events, async () => {}).getReader();
      await reader.read();
      await inFlight.promise;
      await reader.cancel();
      gate.resolve();
      await vi.waitFor(() => expect(state.finallyRuns).toBe(1));
    });

    expect(unhandled).toEqual([]);
    expect(state.finallyRuns).toBe(1);
    expect(state.resumedPastBadEvent).toBe(false);
  });

  it("logs a throwing finally exactly once and raises nothing unhandled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cleanupError = new Error("settle_spend failed");
    const { events, gate, inFlight, state } = pipelineWithGate(() => {
      throw cleanupError;
    });

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(events, async () => {}).getReader();
      await reader.read();
      await inFlight.promise;
      await reader.cancel();
      gate.resolve();
      await vi.waitFor(() => expect(state.finallyRuns).toBe(1));
    });

    expect(unhandled).toEqual([]);
    expect(state.finallyRuns).toBe(1);
    const cleanupLogs = error.mock.calls.filter(
      ([first]) => first === FAILED_RUN_CLEANUP || first === DISCONNECT_CLEANUP,
    );
    expect(cleanupLogs).toHaveLength(1);
    expect(cleanupLogs[0][1]).toBe(cleanupError);
  });
});

describe("existing exits still log as before", () => {
  it("a good event arriving after a mid-stage cancel logs as a disconnect, not a failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = deferred();
    const inFlight = deferred();
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "started" };
        inFlight.resolve();
        await gate.promise;
        yield { stage: "clustering" };
      } finally {
        finallyRuns += 1;
      }
    })();

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(events, async () => {}).getReader();
      await reader.read();
      await inFlight.promise;
      await reader.cancel();
      gate.resolve();
      await vi.waitFor(() => expect(finallyRuns).toBe(1));
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    });

    expect(unhandled).toEqual([]);
    expect(firstArgs(warn)).toEqual([DISCONNECT_WARN]);
    expect(error).not.toHaveBeenCalled();
    expect(finallyRuns).toBe(1);
  });

  it("a stage that genuinely fails after a mid-stage cancel still logs as a pipeline failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = deferred();
    const inFlight = deferred();
    const boom = new Error("triage blew up");
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "started" };
        inFlight.resolve();
        await gate.promise;
        throw boom;
      } finally {
        finallyRuns += 1;
      }
    })();

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(events, async () => {}).getReader();
      await reader.read();
      await inFlight.promise;
      await reader.cancel();
      gate.resolve();
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
    });

    expect(unhandled).toEqual([]);
    expect(error.mock.calls).toEqual([[PIPELINE_FAILED, boom]]);
    expect(warn).not.toHaveBeenCalled();
    expect(finallyRuns).toBe(1);
  });
});

describe("the done branch's return throwing", () => {
  it("sends done then exactly one error event, runs the finally once, and logs no second cleanup", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanupError = new Error("release_generation failed");
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "done" };
      } finally {
        finallyRuns += 1;
        throw cleanupError;
      }
    })();

    let text = "";
    const unhandled = await watchUnhandled(async () => {
      text = await new Response(toNdjsonStream(events, async () => {})).text();
    });

    expect(unhandled).toEqual([]);
    expect(text).toBe(`{"stage":"done"}\n${ERROR_LINE}`);
    expect(finallyRuns).toBe(1);
    expect(error.mock.calls).toEqual([[PIPELINE_FAILED, cleanupError]]);
  });
});

describe("an unserialisable event", () => {
  it("on a done-stage event still runs the finally once and sends only the error event", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield { stage: "done", n: BigInt(3) };
      } finally {
        finallyRuns += 1;
      }
    })();

    const text = await new Response(toNdjsonStream(events, async () => {})).text();

    expect(text).toBe(ERROR_LINE);
    expect(finallyRuns).toBe(1);
  });

  it("whose toJSON throws runs the finally once and sends only the error event", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let finallyRuns = 0;
    const events = (async function* (): AsyncGenerator<Event> {
      try {
        yield {
          stage: "writing",
          toJSON() {
            throw new Error("toJSON blew up");
          },
        };
      } finally {
        finallyRuns += 1;
      }
    })();

    const text = await new Response(toNdjsonStream(events, async () => {})).text();

    expect(text).toBe(ERROR_LINE);
    expect(finallyRuns).toBe(1);
  });
});

describe("a hand-rolled iterator with no return()", () => {
  it("cancel mid-stream does not throw on the missing return", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const iterator = {
      next: async () => ({ value: { stage: `s${n++}` }, done: false as const }),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as AsyncGenerator<Event>;

    const unhandled = await watchUnhandled(async () => {
      const reader = toNdjsonStream(iterator, async () => {}).getReader();
      await reader.read();
      await expect(reader.cancel()).resolves.toBeUndefined();
    });

    expect(unhandled).toEqual([]);
  });

  it("an unserialisable event still sends the error event and closes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const iterator = {
      next: async () => ({ value: { stage: "x", n: BigInt(1) }, done: false as const }),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as AsyncGenerator<Event>;

    const text = await new Response(toNdjsonStream(iterator, async () => {})).text();
    expect(text).toBe(ERROR_LINE);
  });
});
