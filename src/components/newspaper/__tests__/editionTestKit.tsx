import { vi } from "vitest";
import type { Card, Topic } from "@/types";

/**
 * Test-only helpers for the edition loaders: a `/api/digest` stand-in whose
 * NDJSON stream the test feeds one event at a time, and a card factory.
 */

export type ScriptedStream = {
  send: (event: Record<string, unknown>) => void;
  close: () => void;
};

/**
 * Replaces global fetch so each call returns a fresh stream the test drives.
 * `streams` grows by one per call, in call order.
 */
export function stubDigestFetch(): { streams: ScriptedStream[]; fetch: ReturnType<typeof vi.fn> } {
  const streams: ScriptedStream[] = [];
  const encoder = new TextEncoder();
  const fetch = vi.fn(async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    streams.push({
      send: (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
      close: () => controller.close(),
    });
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return { streams, fetch };
}

export function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    topic: "Science" as Topic,
    title: `Title ${id}`,
    shortSummary: `Summary ${id}`,
    labels: [],
    expandedReport: null,
    sources: [],
    publishedAt: "2026-10-08T06:00:00Z",
    generatedAt: "2026-10-08T07:12:00Z",
    bookmarked: false,
    severity: 3,
    frontPageRank: null,
    subtopic: null,
    ...overrides,
  };
}
