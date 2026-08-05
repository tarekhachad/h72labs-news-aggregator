"use client";

import { useState } from "react";
import type { Card, Digest, Topic } from "@/types";
import { TopicBand } from "@/components/newspaper/TopicBand";
import { PageGrid } from "@/components/newspaper/PageGrid";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { tierForFrontPageRank } from "@/lib/gridTiers";
import { Button } from "@/components/ui/button";

// Mirrors the DigestEvent["stage"] union the API streams — kept as plain
// strings here since the client doesn't need the payload types, just the
// stage name and its position for the progress bar. (Same convention as
// the old Feed.tsx, which this component replaces.)
const STAGE_ORDER = ["ingesting", "clustering", "triaging", "writing", "ranking", "done"] as const;
type Stage = (typeof STAGE_ORDER)[number];
type StageEvent = { stage: Stage } & Record<string, unknown>;
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

function frontPageCardsOf(cards: Card[]): Card[] {
  return cards
    .filter((c) => c.frontPageRank !== null)
    .sort((a, b) => (a.frontPageRank as number) - (b.frontPageRank as number));
}

/**
 * The front page: today's top-6 cross-topic stories, plus the
 * "Give me/Complete today's news" generation trigger and its live progress
 * — per Tarek's call, this trigger lives here only (not on every page via
 * the masthead), matching how a real newspaper's daily edition works.
 * Replaces the generation half of the old (pre-4.4) Feed.tsx; the topic-tab
 * half is gone — topics are now real routes, navigated via TopicBand.
 */
export function FrontPage({
  initialDigest,
  userTopics,
  interactive = true,
  basePath = "",
}: {
  initialDigest: Digest | null;
  userTopics: Topic[];
  /** false for a past /history/[date] front page — no generation trigger for a day that's already over. */
  interactive?: boolean;
  /** "/history/2026-08-01" when this is a past date's front page, so TopicBand's links stay scoped to that date. */
  basePath?: string;
}) {
  const [cards, setCards] = useState<Card[] | null>(initialDigest?.cards ?? null);
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
        const message = await res.text().catch(() => "");
        throw new Error(message || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
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
        // Additive, not a replace — see getDigestForDate/upsertDigestForToday:
        // the server's since-cursor only ever returns cards published after
        // the last run, so this run's cards can't overlap what's on screen.
        // rank.ts's ranking pass also rewrites frontPageRank on *existing*
        // cards (a later run's bigger story can dethrone an earlier pick),
        // but the server only returns the new cards here, not the
        // existing ones' updated ranks — a reload picks those up via
        // getDigestForDate. Acceptable for v1: the common case (generate
        // once per day) never hits this staleness window.
        setCards((prev) => [...(prev ?? []), ...newCards]);
      } else {
        setStageEvent(event as StageEvent);
      }
    }
  }

  const stageIndex = stageEvent ? STAGE_ORDER.indexOf(stageEvent.stage) : -1;
  const progressPercent = stageIndex >= 0 ? (stageIndex / (STAGE_ORDER.length - 1)) * 100 : 0;
  const frontPageCards = cards ? frontPageCardsOf(cards) : [];

  return (
    <div className="flex flex-col">
      <TopicBand topics={userTopics} basePath={basePath} />

      {interactive && (
        <div className="flex flex-col items-center gap-4 px-6 py-8 text-center md:px-10">
          <Button onClick={loadDigest} disabled={loading} className="cursor-pointer">
            {hasDigest ? "Complete today's news" : "Give me today's news"}
          </Button>

          {loading && (
            <div className="w-full max-w-xs">
              <div
                className="h-1.5 w-full overflow-hidden rounded-full"
                style={{ background: "var(--color-muted)" }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${progressPercent}%`, background: "var(--color-primary)" }}
                />
              </div>
              <p className="mt-2 text-xs" style={{ color: "var(--color-muted-foreground)" }}>
                {stageEvent ? stageLabel(stageEvent.stage, stageEvent) : STAGE_LABEL.ingesting}
              </p>
            </div>
          )}

          {error && (
            <p className="text-sm" style={{ color: "var(--color-destructive)" }}>
              {error}
            </p>
          )}
        </div>
      )}

      <div className="px-6 pb-10 md:px-10">
        {frontPageCards.length === 0 ? (
          <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            {interactive
              ? hasDigest
                ? "No front-page stories yet today."
                : "No edition yet today."
              : "No edition that day."}
          </p>
        ) : (
          <PageGrid>
            {frontPageCards.map((card) => (
              <NewsCard
                key={card.id}
                card={card}
                tier={tierForFrontPageRank(card.frontPageRank as number)}
                showTopicBadge
              />
            ))}
          </PageGrid>
        )}
      </div>
    </div>
  );
}
