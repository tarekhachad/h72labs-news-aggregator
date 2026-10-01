"use client";

import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import type { SavedCard } from "@/lib/bookmarks";
import { CardItem } from "@/components/CardItem";

export function SavedList({ initialCards }: { initialCards: SavedCard[] }) {
  const [cards, setCards] = useState(initialCards);
  const prefersReducedMotion = useReducedMotion();

  function handleBookmarkChange(cardId: string, bookmarked: boolean) {
    // This view only ever shows bookmarked cards — un-bookmarking one here
    // means it no longer belongs on this page, unlike a feed view that just
    // flips the card's own bookmarked flag in place and keeps it visible.
    if (!bookmarked) {
      setCards((prev) => prev.filter((c) => c.id !== cardId));
    }
  }

  return (
    // No gap-4 here — spacing is a per-item mb-4 instead (see below), since
    // a container-level gap isn't itself animatable: it stays fixed while
    // an exiting card's height shrinks to 0, leaving a phantom empty band
    // instead of one smooth collapse.
    //
    // Every child carries the same mb-4, the last one included, and the
    // container's -mb-4 cancels the final one. Don't swap this for
    // `last:mb-0`: that makes a card's margin depend on its position, so
    // when the last card's exit ends and its node is removed, the new last
    // card's margin drops 16px in a single frame. Here the only margin that
    // ever changes is the exiting card's own, which the exit animates.
    //
    // The empty state lives INSIDE
    // AnimatePresence (not an early return above it) so un-bookmarking the
    // last saved card still gets to play its exit animation — an early
    // return here would swap this component's whole output to the empty
    // message in the same render the card leaves `cards`, unmounting
    // AnimatePresence (and every child it's tracking) before the exit
    // transition ever runs.
    <div className="-mb-4 flex flex-col">
      <AnimatePresence initial={false}>
        {cards.length === 0 ? (
          <p
            key="empty"
            className="mb-4 text-center text-sm"
            style={{ color: "var(--color-muted-foreground)" }}
          >
            Nothing saved yet.
          </p>
        ) : (
          cards.map((card) => (
            <motion.div
              key={card.id}
              layout={prefersReducedMotion ? false : "position"}
              initial={false}
              exit={prefersReducedMotion ? undefined : { opacity: 0, height: 0, marginBottom: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="mb-4 flex flex-col gap-1 overflow-hidden"
            >
              {card.date && (
                <span className="px-1 text-xs" style={{ color: "var(--color-muted-foreground)" }}>
                  From {card.date}
                </span>
              )}
              <CardItem card={card} onBookmarkChange={handleBookmarkChange} />
            </motion.div>
          ))
        )}
      </AnimatePresence>
    </div>
  );
}
