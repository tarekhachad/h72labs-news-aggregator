"use client";

import { useSyncExternalStore } from "react";
import { X } from "lucide-react";

/** Per device: set once the reader dismisses the tips, in this browser's localStorage. */
export const READING_TIPS_STORAGE_KEY = "pna:reading-tips-dismissed";

// The dismissal also lives in memory, so it holds for this page's lifetime
// even when storage throws (a private window, blocked site data) and the
// write never lands.
let dismissedInMemory = false;
const listeners = new Set<() => void>();

function readDismissed(): boolean {
  if (dismissedInMemory) return true;
  try {
    return window.localStorage.getItem(READING_TIPS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab dismissing them hides them here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === READING_TIPS_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function dismiss() {
  dismissedInMemory = true;
  try {
    window.localStorage.setItem(READING_TIPS_STORAGE_KEY, "1");
  } catch {
    // Storage unavailable: the in-memory flag above still hides them.
  }
  listeners.forEach((l) => l());
}

/** Test-only: forget the in-memory dismissal between tests. */
export function resetReadingTipsForTests() {
  dismissedInMemory = false;
}

/**
 * The one-time "how to read it" strip, shown once a reader has cards on the
 * page until they dismiss it on this device. The server always renders it
 * hidden (it can't see localStorage), so a reader who already dismissed it
 * never sees it flash.
 */
export function ReadingTips() {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  if (dismissed) return null;

  return (
    <aside
      aria-label="How to read your paper"
      data-testid="reading-tips"
      className="mx-6 mt-4 flex items-start gap-3 border-y py-2.5 text-[14px] md:mx-10"
      style={{ borderColor: "var(--color-rule)" }}
    >
      <p className="min-w-0 flex-1 leading-normal">
        <span className="mr-2 font-heading font-bold">How to read it:</span>
        Click a card to read it in full · Sources flips it to show the original articles · Save keeps it · Your
        topics are the tabs above.
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss reading tips"
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-[var(--color-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </aside>
  );
}
