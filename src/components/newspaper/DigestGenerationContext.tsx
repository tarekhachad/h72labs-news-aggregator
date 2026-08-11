"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { Card } from "@/types";

// Mirrors the DigestEvent["stage"] union the API streams — kept as plain
// strings here since the client doesn't need the payload types, just the
// stage name and its position for the progress bar.
export const STAGE_ORDER = ["ingesting", "clustering", "triaging", "writing", "ranking", "done"] as const;
export type Stage = (typeof STAGE_ORDER)[number];
export type StageEvent = { stage: Stage } & Record<string, unknown>;
type WireEvent = { stage: Stage | "error" } & Record<string, unknown>;

// Duplicated rather than imported from a server-oriented lib module into a
// client bundle — matches digests.ts's own todayDateString() comment
// acknowledging this duplication (both call sites need it).
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

interface DigestGenerationContextValue {
  cards: Card[] | undefined;
  seededDate: string | null;
  loading: boolean;
  stageEvent: StageEvent | null;
  error: string | null;
  recentlyAddedIds: Set<string>;
  seed: (cards: Card[], date: string) => void;
  startGeneration: () => void;
}

const DigestGenerationContext = createContext<DigestGenerationContextValue | null>(null);

/**
 * Owns digest-generation progress (cards/loading/stageEvent/error) and the
 * fetch/NDJSON-stream-reading loop that drives it, mounted once at the
 * (paper) layout level rather than inside FrontPage — Next.js remounts
 * FrontPage on every navigation between `/`, `/history`, `/saved`, etc.
 * (they're all siblings under one layout), which used to destroy this state
 * (and orphan the still-running fetch's setState calls) the instant the
 * user navigated away mid-generation. Living here instead, this survives
 * exactly like PageTransitionProvider already does.
 */
export function DigestGenerationProvider({ children }: { children: React.ReactNode }) {
  const [cards, setCards] = useState<Card[] | undefined>(undefined);
  const [seededDate, setSeededDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stageEvent, setStageEvent] = useState<StageEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentlyAddedIds, setRecentlyAddedIds] = useState<Set<string>>(new Set());

  // Tracks which date (if any) currently has a generation fetch in flight —
  // a date, not a bare boolean, so a stale run left over from a date seed()
  // has since moved past (e.g. one still in flight exactly at the UTC day
  // rollover, still running when a navigate-away-and-back reseeds to the
  // new day) can't block a fresh startGeneration() call for the new date:
  // it's simply irrelevant to it once tracking has moved on. Also lets
  // processLine/finally below tell whether their own run is still the one
  // the UI currently cares about, so a stale run's late-arriving progress/
  // result can't overwrite a newer date's already-reset state.
  const inFlightDateRef = useRef<string | null>(null);

  // Mirrors `seededDate` so seed() can read the current value synchronously
  // rather than nesting a setCards() call inside setSeededDate's updater —
  // React explicitly double-invokes updater functions in Strict Mode dev to
  // catch exactly that impurity; today's identical-array reference made the
  // second invocation a harmless no-op, but that was fragile, not correct.
  const seededDateRef = useRef<string | null>(null);

  const seed = useCallback((initialCards: Card[], date: string) => {
    // Already tracking this date — either a live run is in flight or one
    // already finished this session. Never clobber that with a
    // server-rendered snapshot that's now stale: this is exactly what makes
    // navigating away mid-generation and back resume instead of re-flashing
    // an empty SSR snapshot.
    if (seededDateRef.current === date) return;
    seededDateRef.current = date;
    setSeededDate(date);
    setCards(initialCards);
    // A date change means every field below belongs to a *different* day —
    // e.g. a tab left open across the UTC day rollover with yesterday's
    // unresolved `error` still set (nothing else clears it until the next
    // startGeneration() call). Reset them all alongside `cards`/`seededDate`
    // so none of it can leak forward and render as if it were today's.
    setLoading(false);
    setStageEvent(null);
    setError(null);
    setRecentlyAddedIds(new Set());
  }, []);

  const startGeneration = useCallback(() => {
    // The date this run belongs to — captured once, up front. Should always
    // be non-null by the time a user can actually click the button (seed()
    // runs in FrontPage's mount effect, before paint settles), but the null
    // check below is a real, reachable guard for the brief pre-effect
    // window, not dead code.
    const runDate = seededDateRef.current;
    if (runDate === null || inFlightDateRef.current === runDate) return;
    inFlightDateRef.current = runDate;
    setLoading(true);
    setError(null);
    setStageEvent({ stage: "ingesting" });

    (async () => {
      let reachedTerminalEvent = false;

      try {
        const res = await fetch("/api/digest", { method: "POST" });
        if (!res.ok || !res.body) {
          const message = await res.text().catch(() => "");
          throw new Error(message || `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) processLine(line);
        }
        processLine(buffer);

        if (!reachedTerminalEvent) {
          throw new Error("Connection to the server was lost before the digest finished.");
        }
      } catch (e) {
        // Only surface the error against `runDate`'s own state — if
        // seed() has since moved on to a different date, this run is
        // stale and its failure isn't this UI's problem to show.
        if (seededDateRef.current === runDate) {
          setError(e instanceof Error ? e.message : "Something went wrong");
        }
      } finally {
        // Only clears the ref if it's still pointing at THIS run (a later
        // call for a different date may have already overwritten it — safe
        // in practice since seed() only ever seeds forward to the real
        // current UTC day, from FrontPage's single call site, so an older
        // run's finally can't stomp a newer one's claim). This is what stops
        // a stale run from permanently blocking a fresh startGeneration()
        // call for whatever date is current by the time this one finishes.
        if (inFlightDateRef.current === runDate) inFlightDateRef.current = null;
        // But only touch the shared loading/stageEvent state if `runDate`
        // is still the one currently tracked — seed() already reset both
        // to their correct idle values for any newer date, and a stale
        // run's completion must not stomp back over that.
        if (seededDateRef.current === runDate) {
          setLoading(false);
          setStageEvent(null);
        }
      }

      function processLine(line: string) {
        if (!line.trim()) return;
        const event = JSON.parse(line) as WireEvent;

        if (event.stage === "error") {
          reachedTerminalEvent = true;
          throw new Error((event.message as string) ?? "Digest failed");
        }
        if (event.stage === "done") {
          reachedTerminalEvent = true;
          // A stale run (its date no longer the one being tracked, per the
          // same reasoning as the catch/finally guards above) discards its
          // own results rather than merging cards into a different date's
          // already-reset state.
          if (seededDateRef.current !== runDate) return;
          const newCards = event.cards as Card[];
          // Additive, not a replace — see getDigestForDate/upsertDigestForToday:
          // the server's since-cursor only ever returns cards published after
          // the last run, so this run's cards can't overlap what's on screen.
          // rank.ts's ranking pass also rewrites frontPageRank on *existing*
          // cards (a later run's bigger story can dethrone an earlier pick),
          // but the server only returns the new cards here, not the
          // existing ones' updated ranks — a reload picks those up via
          // getDigestForDate. Acceptable for v1: the common case (generate
          // once per day) never hits this staleness window.
          setCards((prev) => [...(prev ?? []), ...newCards]);
          setRecentlyAddedIds((prev) => {
            const next = new Set(prev);
            newCards.forEach((c) => next.add(c.id));
            return next;
          });
          // Stamp defensively in case this run started before FrontPage's
          // own seed() call landed (belt-and-suspenders — in practice
          // seed() always runs first, on mount). Safe now that the guard
          // above already confirmed runDate === seededDateRef.current, so
          // todayDateString() can't disagree with it.
          setSeededDate(todayDateString());
        } else if (seededDateRef.current === runDate) {
          setStageEvent(event as StageEvent);
        }
      }
    })();
  }, []);

  return (
    <DigestGenerationContext.Provider
      value={{ cards, seededDate, loading, stageEvent, error, recentlyAddedIds, seed, startGeneration }}
    >
      {children}
    </DigestGenerationContext.Provider>
  );
}

export function useDigestGeneration() {
  const ctx = useContext(DigestGenerationContext);
  if (!ctx) {
    throw new Error("useDigestGeneration must be used within a DigestGenerationProvider");
  }
  return ctx;
}
