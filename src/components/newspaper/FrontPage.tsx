"use client";

import { useEffect, useRef } from "react";
import { motion, useReducedMotion, LayoutGroup } from "motion/react";
import type { Card, Digest, Topic } from "@/types";
import { TopicNav } from "@/components/newspaper/TopicNav";
import { PageGrid } from "@/components/newspaper/PageGrid";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { RunDivider } from "@/components/newspaper/RunDivider";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";
import {
  useDigestGeneration,
  STAGE_ORDER,
  type Stage,
} from "@/components/newspaper/DigestGenerationContext";
import { tierForFrontPageRank } from "@/lib/gridTiers";
import { packGridWithRunDividers } from "@/lib/packGrid";
import { Button } from "@/components/ui/button";

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
 * half is gone — topics are now real routes, navigated via TopicNav.
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
  /** "/history/2026-08-01" when this is a past date's front page, so TopicNav's links stay scoped to that date. */
  basePath?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const digestGen = useDigestGeneration();
  const todayKey = new Date().toISOString().slice(0, 10);

  // Only the live front page participates in the shared generation state —
  // a past /history/[date] front page (interactive=false) always has a
  // complete, static digest and never has a live generation to resume.
  const seeded = interactive && digestGen.seededDate === todayKey;

  const cards = seeded ? (digestGen.cards ?? []) : initialDigest?.cards;
  const loading = seeded ? digestGen.loading : false;
  const stageEvent = seeded ? digestGen.stageEvent : null;
  const error = seeded ? digestGen.error : null;
  // Cards present on the initial (SSR) render never animate in — only ones
  // that land live via this session's own generation runs, so a page
  // reload doesn't replay an entrance for content that was already there.
  // Scoped to `interactive` (not read unconditionally) so a live
  // generation's entrance never incorrectly replays if this same session
  // later visits a /history/[today] view of today's own date.
  const recentlyAddedIds = interactive ? digestGen.recentlyAddedIds : new Set<string>();

  // Hands this mount's server-rendered snapshot to the shared context once.
  // No-op if a live/finished run from an earlier mount this session already
  // owns today's state (see seed()'s own doc comment) — that's what makes
  // navigating away mid-generation and back resume instead of re-flashing
  // the SSR snapshot.
  const seededRef = useRef(false);
  const { seed } = digestGen;
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (interactive) seed(initialDigest?.cards ?? [], todayKey);
  }, [interactive, initialDigest, todayKey, seed]);

  const hasDigest = cards !== undefined && cards.length > 0;

  const stageIndex = stageEvent ? STAGE_ORDER.indexOf(stageEvent.stage) : -1;
  const progressPercent = stageIndex >= 0 ? (stageIndex / (STAGE_ORDER.length - 1)) * 100 : 0;
  const frontPageCards = cards ? frontPageCardsOf(cards) : [];
  const { gridPositions, dividers } = packGridWithRunDividers(
    frontPageCards.map((card) => ({
      id: card.id,
      tier: tierForFrontPageRank(card.frontPageRank as number),
      generatedAt: card.generatedAt,
    }))
  );

  return (
    <div className="flex flex-col">
      {/* interactive=false is always a history front page, which always has
          a digest by construction — only gate on the live page's own
          reactive hasDigest state. */}
      <TopicNav topics={userTopics} basePath={basePath} digestExistsToday={interactive ? hasDigest : true} />

      {interactive && (
        <div className="flex flex-col items-center gap-4 px-6 py-8 text-center md:px-10">
          <Button onClick={digestGen.startGeneration} disabled={loading} className="cursor-pointer">
            {hasDigest ? "Complete today's news" : "Give me today's news"}
          </Button>

          {loading && (
            <motion.div
              className="w-full max-w-xs"
              initial={prefersReducedMotion ? undefined : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
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
            </motion.div>
          )}

          {error && (
            <p className="text-sm" style={{ color: "var(--color-destructive)" }}>
              {error}
            </p>
          )}
        </div>
      )}

      <div className="px-6 pt-4 pb-10 md:px-10">
        {frontPageCards.length === 0 ? (
          <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            {interactive
              ? hasDigest
                ? "No front-page stories yet today."
                : "No edition yet today."
              : "No edition that day."}
          </p>
        ) : (
          // Scoped per page instance (page-type + topic + date) so Motion's
          // shared-layout registry can't connect a card here to the same
          // card.id's layoutId on a different page (e.g. this card also
          // appearing in its own topic's page) — without this, navigating
          // between the two could misread an unrelated tree swap as "this
          // element moved" and animate a slide between them. See Phase 6.5.
          <LayoutGroup id={`front-${basePath || "today"}`}>
            <FocusModeProvider>
              <PageGrid>
                {frontPageCards.map((card, i) => (
                  <NewsCard
                    key={card.id}
                    card={card}
                    tier={tierForFrontPageRank(card.frontPageRank as number)}
                    gridPosition={gridPositions.get(card.id)}
                    showTopicBadge
                    // Only cards that landed live this session (via
                    // DigestGenerationContext's stream, not the initial SSR
                    // render) get an entrance — otherwise every page load
                    // would replay the "just arrived" animation for content
                    // that's already there.
                    isNew={recentlyAddedIds.has(card.id)}
                    entranceDelay={i * 0.04}
                  />
                ))}
                {dividers.map((d) => (
                  // Keyed on gridRow, not generatedAt: interleaved runs (a
                  // later run's card dethroning an earlier one's rank, see
                  // packGridWithRunDividers's own doc comment) can produce
                  // more than one divider for the *same* run's generatedAt —
                  // gridRow is unique per divider by construction (each one
                  // reserves its own exclusive row), generatedAt isn't.
                  <RunDivider
                    key={d.gridPosition.gridRow}
                    generatedAt={d.generatedAt}
                    gridPosition={d.gridPosition}
                  />
                ))}
              </PageGrid>
            </FocusModeProvider>
          </LayoutGroup>
        )}
      </div>
    </div>
  );
}
