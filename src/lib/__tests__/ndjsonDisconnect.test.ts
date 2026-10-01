import { afterEach, describe, expect, it, vi } from "vitest";
import { DIGEST_FAILED_MESSAGE, toNdjsonStream } from "@/lib/ndjsonStream";

type Event = { stage: string };

const PIPELINE_FAILED = "[digest] pipeline failed:";
const DISCONNECTED = "[digest] client disconnected mid-stream; stopped sending events";

/**
 * A pipeline that sends one event, then waits on a gate before its next
 * step, so a test can close the reader while a stage is in flight. `afterGate`
 * decides what that in-flight stage does once released.
 */
function gatedPipeline(afterGate: "yield" | "throw") {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Resolves once the stream has asked for the next event and the stage is
  // actually running. Cancelling before then would find the generator idle
  // at its first yield, which is a different (and silent) path.
  let markInFlight!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    markInFlight = resolve;
  });
  const events = (async function* (): AsyncGenerator<Event> {
    try {
      yield { stage: "ingesting" };
      markInFlight();
      await gate;
      if (afterGate === "throw") throw new Error("writeCard stage blew up");
      yield { stage: "writing" };
      yield { stage: "done" };
    } finally {
      log.push("finally");
    }
  })();
  return { events, release, inFlight, log };
}

function spyConsole() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  };
}

function loggedPipelineFailure(spy: ReturnType<typeof spyConsole>["error"]) {
  return spy.mock.calls.some(([first]) => first === PIPELINE_FAILED);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toNdjsonStream: disconnect vs real failure", () => {
  it("a real failure still logs pipeline failed and sends the error event", async () => {
    const spy = spyConsole();
    const thrown = new Error("relation does not exist");
    const failing = (async function* (): AsyncGenerator<Event> {
      yield { stage: "ingesting" };
      throw thrown;
    })();

    const text = await new Response(toNdjsonStream(failing, async () => {})).text();

    expect(text).toBe(
      `{"stage":"ingesting"}\n{"stage":"error","message":"${DIGEST_FAILED_MESSAGE}"}\n`,
    );
    expect(spy.error).toHaveBeenCalledWith(PIPELINE_FAILED, thrown);
    expect(spy.warn).not.toHaveBeenCalledWith(DISCONNECTED);
  });

  it("a disconnect mid-stream is logged as a disconnect, not a pipeline failure", async () => {
    const spy = spyConsole();
    const { events, release, inFlight, log } = gatedPipeline("yield");
    const reader = toNdjsonStream(events, async () => {}).getReader();

    await reader.read(); // "ingesting"
    await inFlight; // the next stage is running
    await reader.cancel(); // the browser goes away while that stage is in flight
    release(); // the stage finishes and its event has nowhere to go

    await vi.waitFor(() => expect(spy.warn).toHaveBeenCalledWith(DISCONNECTED));
    expect(loggedPipelineFailure(spy.error)).toBe(false);
    // The generator's cleanup (claim release, spend settlement) still ran.
    await vi.waitFor(() => expect(log).toEqual(["finally"]));
  });

  it("a stage that genuinely fails after the disconnect is still logged as a pipeline failure", async () => {
    const spy = spyConsole();
    const { events, release, inFlight, log } = gatedPipeline("throw");
    const reader = toNdjsonStream(events, async () => {}).getReader();

    await reader.read();
    await inFlight;
    await reader.cancel();
    release();

    await vi.waitFor(() =>
      expect(spy.error).toHaveBeenCalledWith(PIPELINE_FAILED, expect.any(Error)),
    );
    expect(spy.warn).not.toHaveBeenCalledWith(DISCONNECTED);
    await vi.waitFor(() => expect(log).toEqual(["finally"]));
  });
});
