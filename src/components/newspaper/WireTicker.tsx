"use client";

import type { StageEvent } from "@/components/newspaper/DigestGenerationContext";
import { RAIL_STEPS, railStepsReached, runningStageLabel } from "@/components/newspaper/editionStages";

/**
 * Seconds the tape takes per character of one pass, so a long sample scrolls
 * at the same reading speed as a short one (about 70 px a second at this
 * size) rather than racing to fit a fixed duration.
 */
const TAPE_SECONDS_PER_CHAR = 0.1;
const MIN_TAPE_SECONDS = 12;

/**
 * The completing day's loader (option D, wire ticker): fills the edition
 * strip while a run is in flight. The tape scrolls the run's real gathered
 * titles (the reader's topic names before they arrive) across its own window;
 * the stage sentence sits in a separate area to its right that the tape never
 * runs under; a thin red line along the bottom fills by stage.
 *
 * Titles are fetched text and are rendered only as React text. Under reduced
 * motion there is no tape: the stage sentence stands alone.
 */
export function WireTicker({
  stageEvent,
  titles,
  topicNames,
  reducedMotion,
}: {
  stageEvent: StageEvent | null;
  titles: string[];
  topicNames: string[];
  reducedMotion: boolean;
}) {
  const items = titles.length > 0 ? titles : topicNames;
  const progress = railStepsReached(stageEvent) / RAIL_STEPS.length;
  const passChars = items.reduce((sum, t) => sum + t.length + 6, 0);
  const seconds = Math.max(MIN_TAPE_SECONDS, passChars * TAPE_SECONDS_PER_CHAR);

  return (
    <div
      data-testid="wire-ticker"
      className="absolute inset-0 flex items-stretch text-[13px]"
      style={{ background: "var(--color-foreground)", color: "var(--color-background)" }}
    >
      {!reducedMotion && items.length > 0 && (
        <div aria-hidden="true" className="relative min-w-0 flex-1 overflow-hidden" data-testid="wire-tape-window">
          {/* Two identical copies side by side, moved left by exactly one
              copy's width per pass, so the loop has no visible seam. Keyed
              on the list so the tape restarts when the real titles replace
              the topic names. */}
          <div
            key={JSON.stringify(items)}
            className="edition-tape absolute inset-y-0 left-0 flex w-max items-center whitespace-nowrap"
            style={{ animationDuration: `${seconds}s` }}
          >
            {[0, 1].map((copy) => (
              <span key={copy} className="flex items-center">
                {items.map((item, i) => (
                  <span key={i} className="flex items-center pr-10">
                    <span className="mr-2.5 text-[9px]" style={{ color: "var(--color-accent)" }}>
                      ●
                    </span>
                    {item}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      )}
      <div
        className={`flex min-w-0 items-center px-4 md:px-6 ${
          reducedMotion || items.length === 0 ? "flex-1" : "max-w-[45%] shrink-0 border-l"
        }`}
        style={{ borderColor: "rgb(253 251 247 / 0.25)" }}
      >
        {/* Visual only: FrontPage's always-mounted live region announces it. */}
        <p aria-hidden="true" data-testid="wire-stage" className="truncate font-heading italic">
          {runningStageLabel(stageEvent)}
        </p>
      </div>
      <div
        aria-hidden="true"
        data-testid="wire-progress"
        className="absolute bottom-0 left-0 h-[3px]"
        style={{
          width: `${progress * 100}%`,
          background: "var(--color-accent)",
          transition: reducedMotion ? undefined : "width 900ms ease-out",
        }}
      />
    </div>
  );
}
