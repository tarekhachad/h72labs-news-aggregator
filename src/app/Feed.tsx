"use client";

import { useState } from "react";
import { TOPICS, type Card, type Topic } from "@/types";

// Namespaced by user ID, not a single global key — localStorage is scoped
// to the browser, not the account. A shared key would leak one account's
// "since last digest" timestamp into another account's first-ever digest
// on the same browser (e.g. switching test accounts), filtering out
// almost everything instead of correctly falling back to a fresh window.
function lastDigestKey(userId: string): string {
  return `h72-last-digest-at-${userId}`;
}

// Mirrors the DigestEvent["stage"] union the API streams — kept as plain
// strings here since the client doesn't need the payload types, just the
// stage name and its position for the progress bar.
const STAGE_ORDER = ["ingesting", "clustering", "triaging", "writing", "done"] as const;
type Stage = (typeof STAGE_ORDER)[number];
type StageEvent = { stage: Stage } & Record<string, unknown>;
// The wire format also includes an "error" stage, which is handled and
// thrown before it ever reaches component state — StageEvent (state) never
// carries it.
type WireEvent = { stage: Stage | "error" } & Record<string, unknown>;

const STAGE_LABEL: Record<Stage, string> = {
  ingesting: "Gathering articles…",
  clustering: "Grouping articles into stories…",
  triaging: "Checking stories for notability…",
  writing: "Writing cards…",
  done: "Done",
};

function stageLabel(stage: Stage, event: Record<string, unknown>): string {
  if (stage === "clustering" && typeof event.articleCount === "number") {
    return `Grouping ${event.articleCount} articles into stories…`;
  }
  if (stage === "triaging" && typeof event.clusterCount === "number") {
    return `Checking ${event.clusterCount} stories for notability…`;
  }
  if (stage === "writing" && typeof event.notableCount === "number") {
    const n = event.notableCount as number;
    return `Writing ${n} card${n === 1 ? "" : "s"}…`;
  }
  return STAGE_LABEL[stage];
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Canonical TOPICS order, filtered to the topics actually present in this
// digest — stable across re-renders (and across days), unlike sorting by
// card count, which would shuffle tab order depending on what happened to
// be notable that day.
function orderTopics(topics: Topic[]): Topic[] {
  const present = new Set(topics);
  return TOPICS.filter((t) => present.has(t));
}

export function Feed({ userId }: { userId: string }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [activeTopic, setActiveTopic] = useState<Topic | null>(null);
  const [loading, setLoading] = useState(false);
  const [stageEvent, setStageEvent] = useState<StageEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function loadDigest() {
    setLoading(true);
    setError(null);
    setCards(null);
    setTopics(null);
    setActiveTopic(null);
    setExpanded(null);
    setStageEvent({ stage: "ingesting" });

    const requestStartedAt = new Date().toISOString();
    const since = localStorage.getItem(lastDigestKey(userId));
    let reachedTerminalEvent = false;

    try {
      const res = await fetch("/api/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // Flush whatever's left in case the stream ended right after a
          // line but before the trailing newline was read as its own chunk.
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) processLine(line);
      }
      processLine(buffer);

      if (!reachedTerminalEvent) {
        throw new Error("Connection to the server was lost before the digest finished.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
      setStageEvent(null);
    }

    function processLine(line: string) {
      if (!line.trim()) return;
      const event = JSON.parse(line) as WireEvent;

      if (event.stage === "error") {
        reachedTerminalEvent = true;
        throw new Error((event.message as string) ?? "Digest failed");
      }
      if (event.stage === "done") {
        reachedTerminalEvent = true;
        const doneCards = event.cards as Card[];
        // Union with the topics actually present on cards, not just the
        // server's reported topic list — defends against a card silently
        // becoming invisible (matching no tab) if that invariant ever
        // breaks, rather than trusting the two always agree.
        const doneTopics = orderTopics([
          ...(event.topics as Topic[]),
          ...doneCards.map((c) => c.topic),
        ]);
        setCards(doneCards);
        setTopics(doneTopics);
        // Default to the first topic that actually has a card, so opening
        // the digest doesn't land on an empty tab when other topics have
        // real news — falls back to the first topic if every one is empty.
        const firstWithCards = doneTopics.find((t) => doneCards.some((c) => c.topic === t));
        setActiveTopic(firstWithCards ?? doneTopics[0] ?? null);
        localStorage.setItem(lastDigestKey(userId), requestStartedAt);
      } else {
        // "error" and "done" are handled above — only progress stages reach here.
        setStageEvent(event as StageEvent);
      }
    }
  }

  const stageIndex = stageEvent ? STAGE_ORDER.indexOf(stageEvent.stage) : -1;
  const progressPercent = stageIndex >= 0 ? (stageIndex / (STAGE_ORDER.length - 1)) * 100 : 0;

  const activeCards = cards && activeTopic ? cards.filter((c) => c.topic === activeTopic) : [];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Your Daily Briefing
        </h1>
        <button
          onClick={loadDigest}
          disabled={loading}
          className="cursor-pointer rounded-full bg-black px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          Give me today&apos;s news
        </button>

        {loading && (
          <div className="w-full max-w-xs">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className="h-full rounded-full bg-black transition-all duration-500 dark:bg-white"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              {stageEvent ? stageLabel(stageEvent.stage, stageEvent) : STAGE_LABEL.ingesting}
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-center text-sm text-red-600">{error}</p>}

      {topics && topics.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {topics.map((topic) => {
            const count = cards?.filter((c) => c.topic === topic).length ?? 0;
            const isActive = topic === activeTopic;
            return (
              <button
                key={topic}
                onClick={() => setActiveTopic(topic)}
                className={`cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                }`}
              >
                {topic} {count > 0 && <span className="opacity-70">({count})</span>}
              </button>
            );
          })}
        </div>
      )}

      {activeTopic && activeCards.length === 0 && (
        <p className="text-center text-sm text-zinc-500">
          No notable {activeTopic} news today.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {activeCards.map((card, i) => {
          const cardKey = `${card.topic}-${i}`;
          return (
            <div
              key={cardKey}
              className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex items-center justify-between">
                <span className="inline-block rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {card.topic}
                </span>
                <span className="text-xs text-zinc-400">{formatRelativeTime(card.publishedAt)}</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-zinc-800 dark:text-zinc-200">
                {card.shortSummary}
              </p>
              <button
                onClick={() => setExpanded(expanded === cardKey ? null : cardKey)}
                className="mt-3 cursor-pointer text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                {expanded === cardKey ? "Hide sources" : `Sources (${card.sources.length})`}
              </button>
              {expanded === cardKey && (
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
        })}
      </div>
    </div>
  );
}
