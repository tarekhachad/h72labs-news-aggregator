"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { Card } from "@/types";
import { applyRankUpdates, type RankUpdate } from "@/lib/rankUpdates";
import { ENTRANCE_DURATION_SECONDS, ENTRANCE_STAGGER_SECONDS } from "@/lib/entranceTiming";

// Mirrors the DigestEvent["stage"] union the API streams — kept as plain
// strings here since the client doesn't need the payload types, just the
// stage name and its position for the progress bar.
export const STAGE_ORDER = ["ingesting", "clustering", "triaging", "writing", "ranking", "done"] as const;
export type Stage = (typeof STAGE_ORDER)[number];
export type StageEvent = { stage: Stage } & Record<string, unknown>;
type WireEvent = { stage: Stage | "error" } & Record<string, unknown>;

/** Slack on top of duration + stagger before a batch is force-retired. */
const ENTRANCE_RETIRE_MARGIN_MS = 400;

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
  /**
   * Cards awaiting their one-time entrance animation, mapped to the delay
   * (seconds) that staggers them. A Map rather than a Set, and the delay is
   * fixed here at insertion rather than derived from the card's current
   * position in the rendered list, because a *changing* delay is a changing
   * Motion transition value — which re-triggers the entrance on a card that
   * already played it. That's exactly what a second same-day run caused
   * before Phase 8.4: re-ranking reorders the front page, a settled card's
   * index (and so its delay) shifts, and it visibly popped again as though
   * it were new.
   *
   * Entries are removed once played, which is what makes the animation
   * one-shot per card. Without that, any later remount of the same card —
   * closing focus mode remounts its grid cell, and a demotion followed by
   * a promotion unmounts and remounts it outright — would replay the
   * entrance for content that has been on screen for minutes. Cards retire
   * themselves when their animation completes; a timer set alongside each
   * batch catches every case where that can't happen (reduced motion, or
   * an unmount mid-animation).
   */
  pendingEntrances: Map<string, number>;
  markEntrancePlayed: (cardId: string) => void;
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
  const [pendingEntrances, setPendingEntrances] = useState<Map<string, number>>(new Map());

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

  // Called by a card once its entrance animation finishes. Dropping the
  // entry is what makes the animation one-shot: every later render of that
  // card — including a fresh mount after focus mode closes, or after a
  // demotion and re-promotion — then sees no pending entrance and renders
  // statically, instead of popping again for content the reader has
  // already been looking at.
  const markEntrancePlayed = useCallback((cardId: string) => {
    setPendingEntrances((prev) => {
      if (!prev.has(cardId)) return prev;
      const next = new Map(prev);
      next.delete(cardId);
      return next;
    });
  }, []);

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
    setPendingEntrances(new Map());
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
          // Missing rankUpdates is read as "change nothing" rather than
          // "clear everything" — that's the server's own fail-open
          // contract when ranking is skipped or errors, and it also covers
          // a stream opened against an older deployment mid-rollout.
          const rankUpdates = (event.rankUpdates as RankUpdate[] | undefined) ?? [];
          // Additive for this run's own cards — see
          // getDigestForDate/upsertDigestForToday: the server's since-cursor
          // only ever returns cards published after the last run, so they
          // can't overlap what's already on screen.
          //
          // The rank rewrite is the other half, and used to be missing
          // (fixed in Phase 8.4): rank.ts re-ranks the full cumulative pool
          // every run, so a later run's bigger story can dethrone an earlier
          // pick. The server computes and persists those changes but only
          // returns the new cards, so already-rendered cards kept a stale
          // frontPageRank and two cards could both claim rank 1 — rendering
          // two hero-sized cards until a reload. Applied to `prev` *before*
          // appending, so this run's new cards (ranked in the same pass)
          // never land alongside a value the same pass superseded.
          setCards((prev) => [...applyRankUpdates(prev ?? [], rankUpdates), ...newCards]);
          setPendingEntrances((prev) => {
            const next = new Map(prev);
            // Stagger relative to this batch, not to the card's eventual
            // position in the whole front-page list: a single new card
            // should start immediately, not sit out a delay computed from
            // wherever it happens to sort.
            newCards.forEach((c, index) => next.set(c.id, index * ENTRANCE_STAGGER_SECONDS));
            return next;
          });
          // Backstop: retire this batch once its animations must be over.
          //
          // Cards normally retire themselves the instant their entrance
          // finishes (NewsCard's onAnimationComplete), but there are
          // several ways that never fires — reduced motion skips the
          // animation entirely, and any unmount mid-flight (navigating off
          // the front page, a rank update demoting the card) makes Motion
          // drop its event subscriptions. A stranded entry would replay the
          // fade on that card's next mount, for content the reader has
          // already seen.
          //
          // Deliberately owned here rather than by a per-card unmount
          // cleanup: this provider is mounted at the layout level and never
          // unmounts, so there's no cleanup for React Strict Mode's
          // mount/unmount/remount cycle to invoke synthetically. The
          // per-card version of this was tried first and did exactly that —
          // retiring every entrance before it played, freezing cards at
          // opacity 0 in dev.
          //
          // No cleanup on this timer on purpose: it must still fire after
          // the cards it covers have unmounted, since that's the case it
          // exists for. It only ever removes ids, so a late run is
          // harmless, and markEntrancePlayed no-ops on anything already
          // retired.
          const batchIds = newCards.map((c) => c.id);
          const lastStaggerMs = Math.max(0, batchIds.length - 1) * ENTRANCE_STAGGER_SECONDS * 1000;
          window.setTimeout(
            () => {
              setPendingEntrances((prev) => {
                if (!batchIds.some((id) => prev.has(id))) return prev;
                const next = new Map(prev);
                batchIds.forEach((id) => next.delete(id));
                return next;
              });
            },
            lastStaggerMs + ENTRANCE_DURATION_SECONDS * 1000 + ENTRANCE_RETIRE_MARGIN_MS
          );
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
      value={{
        cards,
        seededDate,
        loading,
        stageEvent,
        error,
        pendingEntrances,
        markEntrancePlayed,
        seed,
        startGeneration,
      }}
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
