import { describe, it, expect, vi } from "vitest";
import { toNdjsonStream } from "@/lib/ndjsonStream";

type Event = { stage: string };

function trackedGenerator(log: string[]): AsyncGenerator<Event> {
  return (async function* () {
    log.push("body started");
    try {
      yield { stage: "ingesting" };
      yield { stage: "done" };
    } finally {
      log.push("finally");
    }
  })();
}

describe("toNdjsonStream", () => {
  it("runs the cleanup callback when cancelled before the first pull", async () => {
    const log: string[] = [];
    const onCancelledBeforeStart = vi.fn(async () => {
      log.push("cleanup");
    });

    const stream = toNdjsonStream(trackedGenerator(log), onCancelledBeforeStart);
    // Synchronously, before the stream's first pull has had a chance to run.
    await stream.cancel();

    expect(onCancelledBeforeStart).toHaveBeenCalledTimes(1);
    // The body never ran, so its finally could not have done the cleanup.
    expect(log).toEqual(["cleanup"]);
  });

  it("leaves cleanup to the generator's finally once the body has started", async () => {
    const log: string[] = [];
    const onCancelledBeforeStart = vi.fn(async () => {
      log.push("cleanup");
    });

    const stream = toNdjsonStream(trackedGenerator(log), onCancelledBeforeStart);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(onCancelledBeforeStart).not.toHaveBeenCalled();
    expect(log).toEqual(["body started", "finally"]);
  });

  it("runs the finally after the done event without any cancel", async () => {
    const log: string[] = [];
    const stream = toNdjsonStream(trackedGenerator(log), async () => {
      log.push("cleanup");
    });

    const text = await new Response(stream).text();

    expect(text).toBe('{"stage":"ingesting"}\n{"stage":"done"}\n');
    expect(log).toEqual(["body started", "finally"]);
  });
});
