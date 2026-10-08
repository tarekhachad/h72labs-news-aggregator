"use client";

import { useEffect, useMemo, useState } from "react";
import type { StageEvent } from "@/components/newspaper/DigestGenerationContext";
import { RAIL_STEPS, railStepsReached, runningStageLabel } from "@/components/newspaper/editionStages";

const CHAR_MS = 38;
const LINE_HOLD_MS = 1400;
/** Under reduced motion each line is shown whole, then swapped for the next. */
const STATIC_LINE_MS = 4000;
const RULES_PER_COLUMN = 7;

/**
 * Cycles through `lines`, typing each one out a character at a time, or
 * showing each whole when `typing` is false. Restarts from the first line
 * whenever the list itself changes (the reader's topic names giving way to
 * the run's real titles).
 */
function useTypewriter(lines: string[], typing: boolean): string {
  // JSON rather than a join on some separator: a fetched title can contain
  // any character, so only an encoding round-trips every list exactly.
  const key = JSON.stringify(lines);
  const [state, setState] = useState({ key, line: 0, chars: 0 });
  // Reset during render rather than in an effect: React's "adjusting state
  // when a prop changes" pattern, so the old list never paints a frame.
  if (state.key !== key) setState({ key, line: 0, chars: 0 });
  const current = state.key === key ? state : { key, line: 0, chars: 0 };

  const list = useMemo(() => JSON.parse(key) as string[], [key]);
  const line = list.length > 0 ? list[current.line % list.length] : "";
  // By code point, so an emoji or other astral character is never shown
  // half-typed as a lone surrogate.
  const glyphs = useMemo(() => Array.from(line), [line]);

  useEffect(() => {
    if (list.length === 0) return;
    let delay: number;
    let next: { line: number; chars: number };
    if (!typing) {
      delay = STATIC_LINE_MS;
      next = { line: current.line + 1, chars: 0 };
    } else if (current.chars < glyphs.length) {
      delay = CHAR_MS;
      next = { line: current.line, chars: current.chars + 1 };
    } else {
      delay = LINE_HOLD_MS;
      next = { line: current.line + 1, chars: 0 };
    }
    const timer = window.setTimeout(() => {
      setState((s) => (s.key === key ? { key, ...next } : s));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [key, list, glyphs, typing, current.line, current.chars]);

  return typing ? glyphs.slice(0, current.chars).join("") : line;
}

/**
 * The empty day's loader (option B, typesetting): one line at a time typed
 * under a red caret, two columns of body rules setting below it as the run
 * advances, the five-step rail, and the stage in words.
 *
 * `titles` are the run's real gathered headlines, which arrive with the
 * `clustering` event; until then the reader's own topic names are typed as
 * section heads, so nothing on screen is ever invented. Titles are fetched
 * text and are rendered only as React text.
 */
export function TypesettingLoader({
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
  const showingTitles = titles.length > 0;
  const typed = useTypewriter(showingTitles ? titles : topicNames, !reducedMotion);
  const reached = railStepsReached(stageEvent);
  const rulesLit = Math.round((RULES_PER_COLUMN * 2 * reached) / RAIL_STEPS.length);
  const transition = reducedMotion ? undefined : "transform 380ms ease-out";

  return (
    <div className="flex w-full flex-col items-center gap-5" data-testid="typesetting-loader">
      <div
        aria-hidden="true"
        className="w-full max-w-[460px] border px-5 py-[18px] text-left"
        style={{ background: "var(--color-card)", borderColor: "var(--color-border)" }}
      >
        <div
          data-testid="typeset-line"
          className={
            showingTitles
              ? "min-h-[2.4em] font-heading text-[22px] leading-[1.2] font-bold"
              : "min-h-[2.4em] font-heading text-base leading-[1.5] font-semibold tracking-[0.12em] uppercase"
          }
        >
          {typed}
          <span
            className={`ml-0.5 inline-block h-[1em] w-0.5 align-[-0.12em] ${reducedMotion ? "" : "edition-caret-blink"}`}
            style={{ background: "var(--color-accent)" }}
          />
        </div>
        <div className="mt-3.5 grid grid-cols-2 gap-3.5">
          {[0, 1].map((column) => (
            <div key={column} className="flex flex-col gap-1.5">
              {Array.from({ length: RULES_PER_COLUMN }, (_, i) => {
                const lit = column * RULES_PER_COLUMN + i < rulesLit;
                return (
                  <b
                    key={i}
                    className="block h-1 origin-left"
                    style={{
                      width: `${70 + ((i * 37 + column * 11) % 30)}%`,
                      background: "var(--edition-rule)",
                      transform: lit ? "scaleX(1)" : "scaleX(0)",
                      transition,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <ProgressRail reached={reached} reducedMotion={reducedMotion} />

      {/* Visual only: FrontPage's always-mounted live region announces it. */}
      <p aria-hidden="true" data-testid="typeset-stage" className="min-h-[1.5em] text-[15px]">
        {runningStageLabel(stageEvent)}
      </p>
    </div>
  );
}

function ProgressRail({ reached, reducedMotion }: { reached: number; reducedMotion: boolean }) {
  return (
    <div aria-hidden="true" className="flex w-full max-w-[420px] flex-col gap-1.5" data-testid="progress-rail">
      <div className="flex gap-1.5">
        {RAIL_STEPS.map((step, i) => (
          <i
            key={step}
            data-lit={i < reached ? "true" : "false"}
            className="h-[3px] flex-1"
            style={{
              background: i < reached ? "var(--color-foreground)" : "var(--color-border)",
              transition: reducedMotion ? undefined : "background-color 300ms ease-out",
            }}
          />
        ))}
      </div>
      <div
        className="flex justify-between text-[11px] tracking-[0.08em] uppercase"
        style={{ color: "var(--color-muted-foreground)" }}
      >
        {RAIL_STEPS.map((step) => (
          <span key={step}>{step}</span>
        ))}
      </div>
    </div>
  );
}
