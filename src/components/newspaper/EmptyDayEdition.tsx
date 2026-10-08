"use client";

import type { StageEvent } from "@/components/newspaper/DigestGenerationContext";
import { TypesettingLoader } from "@/components/newspaper/TypesettingLoader";
import { FirstEditionNotice } from "@/components/newspaper/FirstEditionNotice";

/**
 * The live front page on a day with no cards yet: a large centred "Give me
 * today's news" button that gives way to the typesetting loader while the
 * run is in flight. A reader who has never had an edition also gets the
 * notice explaining what the button does.
 *
 * The button stays mounted while the run is in flight, disabled and visually
 * hidden, so it is still a real button a screen reader can find rather than
 * something that vanishes from under keyboard focus.
 */
export function EmptyDayEdition({
  loading,
  onStart,
  stageEvent,
  titles,
  topicNames,
  firstEdition,
  error,
  reducedMotion,
}: {
  loading: boolean;
  onStart: () => void;
  stageEvent: StageEvent | null;
  titles: string[];
  topicNames: string[];
  firstEdition: boolean;
  error: string | null;
  reducedMotion: boolean;
}) {
  return (
    <div
      data-testid="empty-day-edition"
      className="flex min-h-[380px] flex-col items-center justify-center gap-[22px] px-6 py-8 text-center md:px-10"
    >
      {!loading && firstEdition && <FirstEditionNotice />}
      {!loading && <p className="m-0 font-heading text-[15px] italic" style={{ color: "var(--color-muted-foreground)" }}>No edition yet today.</p>}
      <button
        type="button"
        onClick={onStart}
        disabled={loading}
        className={`cursor-pointer rounded-md border-0 bg-[var(--color-foreground)] px-[30px] py-4 font-heading text-[22px] font-semibold text-[var(--color-background)] outline-none hover:bg-black focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-[3px] active:scale-[0.98] motion-safe:transition-[transform,background-color] motion-safe:duration-150 disabled:cursor-default ${
          loading ? "sr-only" : ""
        }`}
      >
        Give me today&apos;s news
      </button>
      {!loading && (
        <p className="m-0 text-[13px]" style={{ color: "var(--color-muted-foreground)" }}>
          Usually about a minute.
        </p>
      )}
      {loading && (
        <TypesettingLoader
          stageEvent={stageEvent}
          titles={titles}
          topicNames={topicNames}
          reducedMotion={reducedMotion}
        />
      )}
      {error && (
        <p className="text-sm" style={{ color: "var(--color-destructive)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
