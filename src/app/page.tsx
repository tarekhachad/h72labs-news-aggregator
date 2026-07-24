"use client";

import { useState } from "react";
import type { Card } from "@/types";

export default function Home() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  async function loadDigest() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/digest", { method: "POST" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setCards(data.cards);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
        <div className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Your Daily Briefing
          </h1>
          <button
            onClick={loadDigest}
            disabled={loading}
            className="rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {loading ? "Gathering today's news…" : "Give me today's news"}
          </button>
        </div>

        {error && (
          <p className="text-center text-sm text-red-600">{error}</p>
        )}

        {cards && cards.length === 0 && (
          <p className="text-center text-sm text-zinc-500">
            No notable stories today.
          </p>
        )}

        <div className="flex flex-col gap-4">
          {cards?.map((card, i) => (
            <div
              key={i}
              className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <span className="inline-block rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {card.topic}
              </span>
              <p className="mt-3 text-sm leading-6 text-zinc-800 dark:text-zinc-200">
                {card.shortSummary}
              </p>
              <button
                onClick={() => setExpanded(expanded === i ? null : i)}
                className="mt-3 text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                {expanded === i
                  ? "Hide sources"
                  : `Sources (${card.sources.length})`}
              </button>
              {expanded === i && (
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
          ))}
        </div>
      </main>
    </div>
  );
}
