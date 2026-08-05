"use client";

import { createContext, useContext, useState } from "react";

/**
 * Tracks which single card (if any) currently has focus mode open, shared
 * across every NewsCard on a page. Without this, two near-simultaneous
 * opens (e.g. a fast double-click landing on adjacent cards before the
 * first's overlay commits) could both set purely-local "focused" state to
 * true — each FocusOverlay instance's `inert` sweep would then step on the
 * other's bookkeeping (one marking the other's own overlay root inert,
 * snapshotting an already-inert ancestor as "previous," and restoring that
 * wrong snapshot on close — permanently stranding the page as
 * non-interactive). Storing a single card id here makes "only one card can
 * be focused at a time" true by construction: opening a new card
 * overwrites the id, which is exactly closing whichever was open before.
 */
const FocusModeContext = createContext<{
  focusedCardId: string | null;
  setFocusedCardId: (id: string | null) => void;
} | null>(null);

export function FocusModeProvider({ children }: { children: React.ReactNode }) {
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  return (
    <FocusModeContext.Provider value={{ focusedCardId, setFocusedCardId }}>
      {children}
    </FocusModeContext.Provider>
  );
}

export function useFocusMode() {
  const ctx = useContext(FocusModeContext);
  if (!ctx) {
    throw new Error("useFocusMode must be used within a FocusModeProvider");
  }
  return ctx;
}
