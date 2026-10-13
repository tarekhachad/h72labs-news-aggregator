"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutGroup } from "motion/react";
import type { SavedCard } from "@/lib/bookmarks";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";
import {
  NO_SAVED_FILTER,
  activeSavedTopic,
  filterSavedCards,
  formatSavedDate,
  savedDateBounds,
  savedTopics,
  type SavedFilter,
} from "@/lib/savedFilters";

const MUTED = { color: "var(--color-muted-foreground)" } as const;

const DATE_INPUT_CLASS =
  "rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1 text-sm text-[var(--color-foreground)]";

/**
 * The reader's saved cards as the digest's own NewsCard (flip, focus mode,
 * the full report), newest-saved first, with filters by topic and by a
 * From/To range of the cards' days. Every saved card is already loaded, so
 * filtering happens here in the browser.
 *
 * Every card is the medium tier in a plain two-column grid, not packGrid:
 * packGrid sorts by tier, which would scramble the saved order.
 */
export function SavedList({ initialCards }: { initialCards: SavedCard[] }) {
  const [cards, setCards] = useState(initialCards);
  const [filter, setFilter] = useState<SavedFilter>(NO_SAVED_FILTER);
  const rootRef = useRef<HTMLElement | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // The shown-list position of a card just removed, until focus has moved.
  const removedAt = useRef<number | null>(null);

  // Un-saving here asks first (NewsCard's confirmUnsave), so by the time
  // this runs the reader has confirmed and the server has agreed.
  function handleBookmarkChange(cardId: string, bookmarked: boolean) {
    if (bookmarked) return;
    removedAt.current = filterSavedCards(cards, filter).findIndex((c) => c.id === cardId);
    setCards((prev) => prev.filter((c) => c.id !== cardId));
  }

  // The removed card held keyboard focus (on its Save, then the dialog), and
  // unmounting it would drop focus to <body>. Hand it to the card that took
  // its place, or the one before it if it was last, or the page heading when
  // no card is left showing. After render, not in the handler: the dialog's
  // inert sweep is undone in the commit that unmounts it, and focus() on an
  // inert element does nothing. Each grid child is one card's root, in
  // shown order; the cards' portals render elsewhere.
  useEffect(() => {
    const at = removedAt.current;
    if (at === null) return;
    removedAt.current = null;
    const shownCards = gridRef.current?.children;
    const target = shownCards?.[at] ?? shownCards?.[at - 1];
    if (target instanceof HTMLElement) {
      target.focus();
      return;
    }
    const heading = rootRef.current?.closest("main")?.querySelector("h1");
    if (!heading) return;
    // A heading isn't focusable on its own; -1 lets a script focus it
    // without adding it to the Tab order.
    if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
    heading.focus();
  }, [cards]);

  if (cards.length === 0) {
    return (
      <p
        ref={(el) => {
          rootRef.current = el;
        }}
        className="px-6 text-center text-sm md:px-10"
        style={MUTED}
      >
        Nothing saved yet. Use &ldquo;☆ Save&rdquo; on any card to keep it here.
      </p>
    );
  }

  const topics = savedTopics(cards);
  const activeTopic = activeSavedTopic(cards, filter.topic);
  const bounds = savedDateBounds(cards);
  const shown = filterSavedCards(cards, filter);
  const filtering = activeTopic !== null || filter.from !== "" || filter.to !== "";
  const rangeBackwards = filter.from !== "" && filter.to !== "" && filter.from > filter.to;

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
      }}
      className="flex flex-col"
    >
      <div className="flex flex-col gap-4 px-6 pb-6 md:px-10">
        <nav aria-label="Filter by topic" className="flex flex-wrap gap-x-4 gap-y-2">
          {[null, ...topics].map((topic) => {
            const current = topic === activeTopic;
            return (
              <button
                key={topic ?? "All"}
                type="button"
                aria-pressed={current}
                onClick={() => setFilter((f) => ({ ...f, topic }))}
                className={
                  current
                    ? "cursor-pointer text-sm font-semibold underline underline-offset-4"
                    : "cursor-pointer text-sm hover:underline"
                }
                style={{ color: current ? "var(--color-foreground)" : "var(--color-muted-foreground)" }}
              >
                {topic ?? "All"}
              </button>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <label className="flex flex-col gap-1 text-xs" style={MUTED}>
            From
            <input
              type="date"
              value={filter.from}
              min={bounds?.min}
              max={filter.to || bounds?.max}
              onChange={(e) => setFilter((f) => ({ ...f, from: e.target.value }))}
              className={DATE_INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs" style={MUTED}>
            To
            <input
              type="date"
              value={filter.to}
              min={filter.from || bounds?.min}
              max={bounds?.max}
              onChange={(e) => setFilter((f) => ({ ...f, to: e.target.value }))}
              className={DATE_INPUT_CLASS}
            />
          </label>
          {filter.from !== "" && (
            <button
              type="button"
              onClick={() => setFilter((f) => ({ ...f, to: f.from }))}
              className="cursor-pointer pb-1.5 text-sm underline"
              style={MUTED}
            >
              Just that day
            </button>
          )}
          {filtering && (
            <button
              type="button"
              onClick={() => setFilter(NO_SAVED_FILTER)}
              className="cursor-pointer pb-1.5 text-sm underline"
              style={MUTED}
            >
              Clear filters
            </button>
          )}
        </div>

        <p className="text-sm" style={MUTED} aria-live="polite">
          {filtering ? `${shown.length} of ${cards.length} saved` : `${cards.length} saved`}
        </p>
      </div>

      <div className="px-6 pb-10 md:px-10">
        {shown.length === 0 ? (
          <p className="text-center text-sm" style={MUTED}>
            {rangeBackwards
              ? "The From date is after the To date."
              : "No saved cards match these filters."}
          </p>
        ) : (
          // Its own LayoutGroup so Motion never links a card here to the
          // same card's layoutId on another page.
          <LayoutGroup id="saved">
            <FocusModeProvider>
              <div ref={gridRef} className="grid grid-cols-1 auto-rows-[380px] gap-5 md:grid-cols-2">
                {shown.map((card) => (
                  <NewsCard
                    key={card.id}
                    card={card}
                    tier="medium"
                    showTopicBadge
                    dateNote={card.date ? `From ${formatSavedDate(card.date)}` : undefined}
                    confirmUnsave
                    onBookmarkChange={handleBookmarkChange}
                  />
                ))}
              </div>
            </FocusModeProvider>
          </LayoutGroup>
        )}
      </div>
    </div>
  );
}
