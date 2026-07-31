"use client";

import { useState } from "react";
import type { SavedCard } from "@/lib/bookmarks";
import { CardItem } from "@/components/CardItem";

export function SavedList({ initialCards }: { initialCards: SavedCard[] }) {
  const [cards, setCards] = useState(initialCards);

  function handleBookmarkChange(cardId: string, bookmarked: boolean) {
    // This view only ever shows bookmarked cards — un-bookmarking one here
    // means it no longer belongs on this page, unlike Feed.tsx which just
    // flips the card's own bookmarked flag in place.
    if (!bookmarked) {
      setCards((prev) => prev.filter((c) => c.id !== cardId));
    }
  }

  if (cards.length === 0) {
    return <p className="text-center text-sm text-zinc-500">Nothing saved yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {cards.map((card) => (
        <div key={card.id} className="flex flex-col gap-1">
          {card.date && (
            <span className="px-1 text-xs text-zinc-400">From {card.date}</span>
          )}
          <CardItem card={card} onBookmarkChange={handleBookmarkChange} />
        </div>
      ))}
    </div>
  );
}
