"use client";

import type { Card } from "@/types";
import type { StageEvent } from "@/components/newspaper/DigestGenerationContext";
import { WireTicker } from "@/components/newspaper/WireTicker";
import { timeInTimeZone } from "@/lib/localDate";

/**
 * "54 stories · updated 07:12": the count of today's cards and the newest
 * `generatedAt` among them as a 24-hour time in the reader's time zone,
 * with the same Morocco correction the app's dates use. The time is left out
 * when no card carries a parseable stamp, so the line never shows
 * "Invalid Date", and for a zone name Intl rejects, where the count alone is
 * still true.
 */
export function editionSummary(cards: Card[], timeZone: string): string {
  const count = `${cards.length} ${cards.length === 1 ? "story" : "stories"}`;
  let latest = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const t = Date.parse(card.generatedAt);
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  if (!Number.isFinite(latest)) return count;
  const time = timeInTimeZone(new Date(latest), timeZone);
  return time === null ? count : `${count} · updated ${time}`;
}

/**
 * The completing day's slim strip, pinned under the topic bar by its parent.
 * Idle, it shows the edition's size and age beside "Complete today's news".
 * Only the button reacts to hover and starts a run; the rest of the strip is
 * plain text. Running, the wire ticker covers it.
 *
 * The button stays mounted (disabled) while a run is in flight, so a
 * screen reader can still find it.
 */
export function EditionStrip({
  summary,
  loading,
  onStart,
  stageEvent,
  titles,
  topicNames,
  reducedMotion,
}: {
  summary: string;
  loading: boolean;
  onStart: () => void;
  stageEvent: StageEvent | null;
  titles: string[];
  topicNames: string[];
  reducedMotion: boolean;
}) {
  return (
    <div
      data-testid="edition-strip"
      className="relative flex h-11 items-center justify-between gap-3 overflow-hidden border-b bg-[var(--color-background)] px-6 md:px-10"
      style={{ borderColor: "var(--color-border)" }}
    >
      <span className="min-w-0 truncate text-[13px]" style={{ color: "var(--color-muted-foreground)" }}>
        {summary}
      </span>
      <button
        type="button"
        onClick={onStart}
        disabled={loading}
        className="shrink-0 cursor-pointer rounded-full border border-[var(--color-foreground)] bg-[var(--color-card)] px-3.5 py-1 font-heading text-[15px] font-semibold whitespace-nowrap text-[var(--color-foreground)] outline-none enabled:hover:bg-[var(--color-foreground)] enabled:hover:text-[var(--color-background)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-55 motion-safe:transition-colors"
      >
        Complete today&apos;s news
      </button>
      {loading && (
        <WireTicker
          stageEvent={stageEvent}
          titles={titles}
          topicNames={topicNames}
          reducedMotion={reducedMotion}
        />
      )}
    </div>
  );
}
