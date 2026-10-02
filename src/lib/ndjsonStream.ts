/**
 * Wraps the digest pipeline's event generator as an NDJSON response body: one
 * JSON line per event.
 *
 * Every exit path must run the generator's `finally`, because that is where
 * the spend reservation is settled and the generation claim released.
 */

import { bestEffortLog } from "@/lib/bestEffortLog";

export const DIGEST_FAILED_MESSAGE = "Digest failed";

export function toNdjsonStream<E extends { stage: string }>(
  events: AsyncGenerator<E>,
  // Cleanup for the narrow case of a cancel arriving before the first pull,
  // where the generator body never ran: returning a generator that has not
  // started skips its finally entirely, so nothing else would settle the
  // reservation or release the claim.
  //
  // This is insurance, not the usual path. A stream with the default queue
  // size pulls once as soon as it is constructed, without waiting for a
  // reader, so by the time a real client disconnect arrives the body has
  // almost always started, and its own finally does the cleanup — settling at
  // whatever was spent, which is $0 while the pipeline is still paused at its
  // first yield. So an abandoned request is free either way.
  onCancelledBeforeStart: () => Promise<void>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let started = false;
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      started = true;
      // True only while calling the controller, so the catch can tell a
      // throw from the stream (its reader is gone) from one out of the
      // pipeline. Both must be told apart even after a cancel: a stage that
      // was already in flight can still genuinely fail.
      let writing = false;
      try {
        const { value, done } = await events.next();
        if (done) {
          writing = true;
          controller.close();
          return;
        }
        const line = encoder.encode(JSON.stringify(value) + "\n");
        writing = true;
        controller.enqueue(line);
        // The digest pipeline never actually yields a "error" stage today —
        // every failure propagates as a thrown exception, handled by the
        // catch block below instead (whose own throw path already runs the
        // generator's finally without needing events.return() here). This
        // branch is kept for defensive symmetry in case a future change
        // ever yields "error" directly.
        if (value.stage === "done" || value.stage === "error") {
          // The generator is still paused right at its final yield — it
          // won't run its own finally block (which releases the
          // generation-mutex claim) until resumed one more time. Force
          // that resumption now, the same way cancel() below already does
          // for early cancellation, instead of just closing the stream
          // and leaving the generator (and its cleanup) suspended forever.
          writing = false;
          await events.return?.(undefined);
          writing = true;
          controller.close();
        }
      } catch (err) {
        if (cancelled && writing) {
          // Not a pipeline failure: the browser went away (tab closed,
          // navigated off) and this event had nowhere to go. The
          // generator's own cleanup is unaffected — cancel() below already
          // asked it to return.
          bestEffortLog("warn", "[digest] client disconnected mid-stream; stopped sending events");
          return;
        }
        // The full error stays in the server log. The client gets a fixed
        // string, so no future throw can carry internal detail to the browser.
        bestEffortLog("error", "[digest] pipeline failed:", err);
        try {
          controller.enqueue(
            encoder.encode(JSON.stringify({ stage: "error", message: DIGEST_FAILED_MESSAGE }) + "\n")
          );
          controller.close();
        } catch {
          // Client already disconnected/canceled the stream — nothing left to tell it.
        }
      }
    },
    async cancel() {
      cancelled = true;
      if (!started) {
        started = true;
        await events.return?.(undefined);
        try {
          await onCancelledBeforeStart();
        } catch (err) {
          // Nothing is left to tell the client, and a rejection here would
          // surface as an unhandled rejection rather than anywhere useful.
          bestEffortLog("error", "[digest] cleanup after an abandoned request failed:", err);
        }
        return;
      }
      // Best-effort: stops the pipeline from starting its next stage once
      // the client has gone away. A stage already in flight (e.g. a Claude
      // call mid-request) still runs to completion — this isn't a hard abort.
      events.return?.(undefined);
    },
  });
}
