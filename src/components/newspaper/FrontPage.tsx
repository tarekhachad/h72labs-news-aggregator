"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, LayoutGroup } from "motion/react";
import type { Card, Digest, Topic } from "@/types";
import { TopicNav } from "@/components/newspaper/TopicNav";
import { PageGrid } from "@/components/newspaper/PageGrid";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusModeProvider, useFocusMode } from "@/components/newspaper/FocusModeContext";
import {
  useDigestGeneration,
  STAGE_ORDER,
  type Stage,
} from "@/components/newspaper/DigestGenerationContext";
import { tierForFrontPageRank } from "@/lib/gridTiers";
import { packGrid } from "@/lib/packGrid";
import { newRunCardIds } from "@/lib/newRun";
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

// Stable reference so history pages (which never have pending entrances)
// pass the same value every render instead of minting a new Map. Nothing
// downstream is memoized today, so this changes no behavior — it just
// avoids a gratuitously unstable prop.
const EMPTY_ENTRANCES: Map<string, number> = new Map();
/** Stable no-op for non-interactive pages, which own no entrance state. */
const NOOP_ENTRANCE_PLAYED = () => {};

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
  const pendingEntrances = interactive ? digestGen.pendingEntrances : EMPTY_ENTRANCES;
  // Gated alongside pendingEntrances, not taken unconditionally: a history
  // page renders cards it does not own the entrance state for, and
  // NewsCard retires on open regardless of whether it was animating. Left
  // ungated, viewing a past date could reach into the live front page's
  // shared state and cut short an in-progress entrance for a card sharing
  // that id. Unreachable today only because /history/<today> redirects to
  // "/" (Phase 8.1) — a guard in an unrelated file that this shouldn't
  // quietly depend on.
  const markEntrancePlayed = interactive ? digestGen.markEntrancePlayed : NOOP_ENTRANCE_PLAYED;

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
        {
          // Always mounted, even with nothing to show: the empty state lives
          // *inside* FrontPageGrid (below) rather than replacing this
          // subtree, because whether the page is empty can only be judged
          // after that component applies its open-card retention. Deciding
          // out here, on the un-retained list, would unmount an open card's
          // overlay in exactly the case retention exists to prevent — a
          // re-rank that demotes every ranked card while one is open.
          //
          // Scoped per page instance (page-type + topic + date) so Motion's
          // shared-layout registry can't connect a card here to the same
          // card.id's layoutId on a different page (e.g. this card also
          // appearing in its own topic's page) — without this, navigating
          // between the two could misread an unrelated tree swap as "this
          // element moved" and animate a slide between them. See Phase 6.5.
          <LayoutGroup id={`front-${basePath || "today"}`}>
            <FocusModeProvider>
              <FrontPageGrid
                cards={frontPageCards}
                pendingEntrances={pendingEntrances}
                onEntrancePlayed={markEntrancePlayed}
                emptyMessage={
                  interactive
                    ? hasDigest
                      ? "No front-page stories yet today."
                      : "No edition yet today."
                    : "No edition that day."
                }
              />
            </FocusModeProvider>
          </LayoutGroup>
        }
      </div>
    </div>
  );
}

/**
 * The card grid itself, split out so it renders *inside* FocusModeProvider
 * and can therefore read which card is currently open.
 *
 * That matters because of a live re-ranking (Phase 8.4): a second same-day
 * run can demote a card off the front page, and since this list is derived
 * purely from frontPageRank, the demoted card's NewsCard would unmount —
 * taking its portaled FocusOverlay with it, and yanking the panel away from
 * a reader mid-sentence. Keeping the focused card in the list until it's
 * closed defers the demotion to a moment the user chose. Everything else
 * about the ordering stays a pure function of rank.
 */
function FrontPageGrid({
  cards,
  pendingEntrances,
  onEntrancePlayed,
  emptyMessage,
}: {
  cards: Card[];
  pendingEntrances: Map<string, number>;
  onEntrancePlayed: (cardId: string) => void;
  /** Shown when there's genuinely nothing to render — judged after retention, not before. */
  emptyMessage: string;
}) {
  const { focusedCardId } = useFocusMode();

  // Snapshot of whichever card is currently open, captured the moment it
  // opens — which is necessarily while it's still on the front page, since
  // you can only open a card that's rendered.
  //
  // Capturing the card *object*, not just its id, is what makes this work:
  // the snapshot still carries the rank the card had before any demotion,
  // so it keeps its original tier and grid slot. Retaining only the id and
  // re-reading the post-update card would yield frontPageRank === null,
  // which tierForFrontPageRank clamps up to hero — a hero-sized phantom
  // gap in the grid, which is worse than the problem being fixed.
  //
  // Adjusted during render rather than in an effect: this is React's
  // documented "adjusting state when a prop changes" pattern, guarded so it
  // only runs when the open card actually changes. An effect would be a
  // cascading render (and this project's lint rejects setState in an effect
  // body outright, for the same reason).
  const [openCard, setOpenCard] = useState<{ id: string | null; card: Card | null }>({
    id: null,
    card: null,
  });
  const listedOpenCard = cards.find((card) => card.id === focusedCardId) ?? null;
  if (openCard.id !== focusedCardId) {
    setOpenCard({ id: focusedCardId, card: listedOpenCard });
  }
  const openCardSnapshot = openCard.id === focusedCardId ? openCard.card : listedOpenCard;

  // Re-append the open card only while it's genuinely gone from the list.
  const visibleCards =
    focusedCardId !== null && listedOpenCard === null && openCardSnapshot !== null
      ? [...cards, openCardSnapshot]
      : cards;

  const gridPositions = packGrid(
    visibleCards.map((card) => ({
      id: card.id,
      tier: tierForFrontPageRank(card.frontPageRank as number),
    }))
  );
  // Empty on an ordinary single-run day, so no badges render at all.
  const newRunIds = newRunCardIds(visibleCards);

  if (visibleCards.length === 0) {
    return (
      <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
        {emptyMessage}
      </p>
    );
  }

  return (
    <PageGrid>
      {visibleCards.map((card) => (
        <NewsCard
          key={card.id}
          card={card}
          tier={tierForFrontPageRank(card.frontPageRank as number)}
          gridPosition={gridPositions.get(card.id)}
          showTopicBadge
          // Only cards that landed live this session (via
          // DigestGenerationContext's stream, not the initial SSR render)
          // get an entrance, and only until they've played it once —
          // otherwise a page load, or a later re-render that merely moved
          // the card, would replay the "just arrived" animation for
          // content that's already there.
          animateEntrance={pendingEntrances.has(card.id)}
          showNewBadge={newRunIds.has(card.id)}
          // Fixed when the card arrived, never derived from its index in
          // this list: the list re-sorts on every re-rank, and a changing
          // delay is a changing Motion transition value, which re-triggers
          // the entrance on a card that already finished it.
          entranceDelay={pendingEntrances.get(card.id) ?? 0}
          onEntrancePlayed={onEntrancePlayed}
        />
      ))}
    </PageGrid>
  );
}
