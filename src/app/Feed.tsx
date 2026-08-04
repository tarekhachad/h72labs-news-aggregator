"use client";

import { Fragment, useState } from "react";
import { TOPICS, type Card, type Digest, type Topic } from "@/types";
import { CardItem } from "@/components/CardItem";
import { RunDivider } from "@/components/RunDivider";

// Mirrors the DigestEvent["stage"] union the API streams — kept as plain
// strings here since the client doesn't need the payload types, just the
// stage name and its position for the progress bar.
const STAGE_ORDER = ["ingesting", "clustering", "triaging", "writing", "ranking", "done"] as const;
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
  ranking: "Picking today's front page…",
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

// Canonical TOPICS order, filtered to the topics actually present in this
// digest — stable across re-renders (and across days), unlike sorting by
// card count, which would shuffle tab order depending on what happened to
// be notable that day.
function orderTopics(topics: Topic[]): Topic[] {
  const present = new Set(topics);
  return TOPICS.filter((t) => present.has(t));
}

export function Feed({
  initialDigest,
  userTopics,
}: {
  /** Today's already-persisted digest, if one exists — null on a brand-new day. */
  initialDigest: Digest | null;
  /**
   * The user's full topic preferences (not just topics with cards) — the
   * tab list is derived from this, not from initialDigest.cards, so a topic
   * with zero notable stories today still shows its tab (with the "no
   * notable news" empty state) instead of silently disappearing on reload.
   */
  userTopics: Topic[];
}) {
  const [cards, setCards] = useState<Card[] | null>(initialDigest?.cards ?? null);
  const [topics, setTopics] = useState<Topic[] | null>(
    initialDigest ? orderTopics(userTopics) : null
  );
  const [activeTopic, setActiveTopic] = useState<Topic | null>(() => {
    if (!initialDigest) return null;
    const ordered = orderTopics(userTopics);
    // Prefer landing on a topic that actually has a story today — falling
    // back to ordered[0] only matters when every selected topic came up
    // empty, so the tab list still has to show *something* as active.
    const withCards = ordered.find((t) => initialDigest.cards.some((c) => c.topic === t));
    return withCards ?? ordered[0] ?? null;
  });
  const [loading, setLoading] = useState(false);
  const [stageEvent, setStageEvent] = useState<StageEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasDigest = cards !== null;

  async function loadDigest() {
    setLoading(true);
    setError(null);
    setStageEvent({ stage: "ingesting" });

    let reachedTerminalEvent = false;

    try {
      const res = await fetch("/api/digest", { method: "POST" });
      if (!res.ok || !res.body) {
        // Plain-text error routes (e.g. the 409 when another tab/click is
        // already generating this digest) aren't NDJSON — surface their
        // body directly rather than a bare status code.
        const message = await res.text().catch(() => "");
        throw new Error(message || `Request failed (${res.status})`);
      }

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
        const newCards = event.cards as Card[];
        // Additive, not a replace: the server's since-cursor (see
        // upsertDigestForToday) only ever returns cards published after the
        // last run that day, so this run's cards and the ones already on
        // screen can't overlap the same underlying article. Re-sorted after
        // merging (not just appended) so a second same-day run — newer
        // publishedAt, but arriving after the older cards in this array —
        // lands in the same recency order a reload would show, matching
        // getDigestForDate's ORDER BY exactly; without this, the run divider
        // below would end up pointing the wrong way, labeling the newer
        // block "earlier."
        setCards((prev) => {
          const merged = [...(prev ?? []), ...newCards];
          merged.sort(
            (a, b) =>
              new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
          );
          return merged;
        });
        // Union with the topics actually present on cards, not just the
        // server's reported topic list — defends against a card silently
        // becoming invisible (matching no tab) if that invariant ever
        // breaks, rather than trusting the two always agree.
        setTopics((prevTopics) =>
          orderTopics([
            ...(prevTopics ?? []),
            ...(event.topics as Topic[]),
            ...newCards.map((c) => c.topic),
          ])
        );
        // Only pick a default tab the very first time a digest ever loads
        // (activeTopic still null) — once one's already selected, later
        // appended cards shouldn't yank the user to a different tab. If
        // activeTopic is null, topics must be null too (no earlier digest),
        // so this run's own topics are the full set, no prior state needed.
        setActiveTopic((prevActive) => {
          if (prevActive) return prevActive;
          const ordered = orderTopics([
            ...(event.topics as Topic[]),
            ...newCards.map((c) => c.topic),
          ]);
          const withCards = ordered.find((t) => newCards.some((c) => c.topic === t));
          return withCards ?? ordered[0] ?? null;
        });
      } else {
        // "error" and "done" are handled above — only progress stages reach here.
        setStageEvent(event as StageEvent);
      }
    }
  }

  function handleBookmarkChange(cardId: string, bookmarked: boolean) {
    setCards((prev) =>
      prev ? prev.map((c) => (c.id === cardId ? { ...c, bookmarked } : c)) : prev
    );
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
          {hasDigest ? "Complete today's news" : "Give me today's news"}
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
          // activeCards is already sorted by recency (see getDigestForDate /
          // route.ts) — a divider marks each point where that order crosses
          // from one same-day generation run into an earlier one, not a
          // full regroup-by-run (which would fight the recency ordering
          // Fix 3 just made stable).
          const isNewRun = i > 0 && card.generatedAt !== activeCards[i - 1].generatedAt;
          return (
            <Fragment key={card.id}>
              {isNewRun && <RunDivider generatedAt={card.generatedAt} />}
              <CardItem card={card} onBookmarkChange={handleBookmarkChange} />
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
