"use client";

import { useEffect } from "react";
import type { Card } from "@/types";

/**
 * FIXTURE ONLY. Invented headlines for the scripted stream below, so the
 * loaders can be seen with real-looking text under dead keys. Nothing here
 * is a real outlet's reporting, and none of it may be used outside
 * /dev/fixtures: the real loaders show only titles a run actually gathered.
 */
const FIXTURE_WIRE_TITLES = [
  "Sample: Central bank holds rates as inflation cools for a third month",
  "Sample: Coastal city opens its first desalination plant",
  "Sample: League leaders drop points in late equaliser",
  "Sample: Researchers report a cheaper catalyst for green hydrogen",
  "Sample: Parliament passes revised data protection bill",
  "Sample: Chipmaker delays new factory by a year",
  "Sample: Drought cuts wheat forecast across the region",
  "Sample: Port strike enters its second week",
  "Sample: Space agency confirms launch window for lunar lander",
  "Sample: Election commission publishes final candidate list",
];

type ScriptStep = { atMs: number; event: Record<string, unknown> };

function script(stepMs: number, doneCards: Card[]): ScriptStep[] {
  return [
    { atMs: 0, event: { stage: "ingesting" } },
    {
      atMs: stepMs * 2,
      event: { stage: "clustering", articleCount: 351, sampleTitles: FIXTURE_WIRE_TITLES },
    },
    { atMs: stepMs * 4, event: { stage: "triaging", clusterCount: 265 } },
    { atMs: stepMs * 6, event: { stage: "writing", notableCount: doneCards.length } },
    { atMs: stepMs * 9, event: { stage: "ranking" } },
    { atMs: stepMs * 10, event: { stage: "done", cards: doneCards, rankUpdates: [] } },
  ];
}

/**
 * FIXTURE ONLY. While mounted, answers the page's `POST /api/digest` with a
 * scripted NDJSON stream on a timer, in place of the real route, so the
 * edition loaders run end to end through the real provider with dead keys.
 * `hold` stops the script at that stage (for screenshots); the run then
 * never finishes. Every other request goes to the real fetch.
 */
export function ScriptedDigestStream({
  doneCards,
  stepMs = 2500,
  hold,
}: {
  doneCards: Card[];
  stepMs?: number;
  hold?: string;
}) {
  useEffect(() => {
    const realFetch = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "POST" || new URL(url, window.location.href).pathname !== "/api/digest") {
        return realFetch(input, init);
      }
      const generatedAt = new Date().toISOString();
      const cards = doneCards.map((c) => ({ ...c, id: `${c.id}-${generatedAt}`, generatedAt }));
      const steps = script(stepMs, cards);
      const holdIndex = hold ? steps.findIndex((s) => s.event.stage === hold) : -1;
      const playable = holdIndex >= 0 ? steps.slice(0, holdIndex + 1) : steps;
      const encoder = new TextEncoder();
      const timers: number[] = [];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          playable.forEach((step, i) => {
            timers.push(
              window.setTimeout(() => {
                controller.enqueue(encoder.encode(`${JSON.stringify(step.event)}\n`));
                if (i === playable.length - 1 && holdIndex < 0) controller.close();
              }, step.atMs)
            );
          });
        },
        cancel() {
          timers.forEach((t) => window.clearTimeout(t));
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    };
    return () => {
      window.fetch = realFetch;
    };
  }, [doneCards, stepMs, hold]);

  return (
    <p
      className="px-6 py-2 text-center text-xs md:px-10"
      style={{ background: "var(--color-muted)", color: "var(--color-muted-foreground)" }}
    >
      Fixture: the button runs a scripted stream with invented sample headlines, not a real run.
      {hold ? ` Held at “${hold}”.` : ""}
    </p>
  );
}
