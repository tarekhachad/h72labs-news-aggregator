"use client";

import { useState } from "react";
import type { Card } from "@/types";
import { formatRelativeTime } from "@/lib/time";

/**
 * Renders one story card: the always-visible short summary, the lazy
 * expand-to-full-report interaction (fetches and caches on first expand,
 * per docs/(C) ARCHITECTURE.md's "expand (lazy)" design), the source list,
 * and a bookmark toggle. Shared by the live feed, the history day view, and
 * the Saved page so all three render a card identically.
 */
export function CardItem({
  card,
  onBookmarkChange,
}: {
  card: Card;
  /** Called after a bookmark toggle round-trips successfully. */
  onBookmarkChange?: (cardId: string, bookmarked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sourcesVisible, setSourcesVisible] = useState(false);
  const [report, setReport] = useState<string | null>(card.expandedReport);
  const [loadingReport, setLoadingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [bookmarked, setBookmarked] = useState(card.bookmarked);
  const [bookmarkPending, setBookmarkPending] = useState(false);

  async function handleExpandToggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (report !== null) return; // Already have it — cached or seeded, no re-fetch.
    // A fetch is already in flight (e.g. a fast collapse/re-expand while it
    // hasn't resolved yet) — without this guard a second request for the
    // same card would fire before the first returns, paying for the Claude
    // call twice.
    if (loadingReport) return;

    setLoadingReport(true);
    setReportError(null);
    try {
      const res = await fetch(`/api/cards/${card.id}/expand`, { method: "POST" });
      if (!res.ok) throw new Error("Couldn't load the full report — try again.");
      const data = (await res.json()) as { expandedReport: string };
      setReport(data.expandedReport);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoadingReport(false);
    }
  }

  async function handleBookmarkToggle() {
    if (bookmarkPending) return;
    const next = !bookmarked;
    setBookmarkPending(true);
    setBookmarked(next); // Optimistic — reverted below on failure.
    try {
      const res = await fetch("/api/bookmarks", {
        method: next ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: card.id }),
      });
      if (!res.ok) throw new Error();
      onBookmarkChange?.(card.id, next);
    } catch {
      setBookmarked(!next);
    } finally {
      setBookmarkPending(false);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-block rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {card.topic}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-400">{formatRelativeTime(card.publishedAt)}</span>
          <button
            onClick={handleBookmarkToggle}
            disabled={bookmarkPending}
            className="cursor-pointer text-xs font-medium text-zinc-500 underline hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-zinc-200"
          >
            {bookmarked ? "★ Saved" : "☆ Save"}
          </button>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-zinc-800 dark:text-zinc-200">
        {card.shortSummary}
      </p>
      <div className="mt-3 flex items-center gap-4">
        <button
          onClick={handleExpandToggle}
          className="cursor-pointer text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          {expanded ? "Hide full report" : "Read full report"}
        </button>
        <button
          onClick={() => setSourcesVisible((v) => !v)}
          className="cursor-pointer text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          {sourcesVisible ? "Hide sources" : `Sources (${card.sources.length})`}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 flex flex-col gap-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {loadingReport && (
            <p className="text-xs text-zinc-500">Loading the full report…</p>
          )}
          {reportError && <p className="text-xs text-red-600">{reportError}</p>}
          {report && (
            <p className="whitespace-pre-line text-sm leading-6 text-zinc-800 dark:text-zinc-200">
              {report}
            </p>
          )}
        </div>
      )}
      {sourcesVisible && (
        <ul className="mt-3 flex flex-col gap-1 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {card.sources.map((s, j) => (
            <li key={j} className="text-xs text-zinc-500">
              <span className="font-medium">{s.source}</span> —{" "}
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
