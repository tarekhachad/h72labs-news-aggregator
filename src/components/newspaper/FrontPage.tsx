"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion, LayoutGroup } from "motion/react";
import type { Card, Digest, Topic } from "@/types";
import { TopicNav } from "@/components/newspaper/TopicNav";
import { PageGrid } from "@/components/newspaper/PageGrid";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusModeProvider, useFocusMode } from "@/components/newspaper/FocusModeContext";
import { useDigestGeneration } from "@/components/newspaper/DigestGenerationContext";
import { EmptyDayEdition } from "@/components/newspaper/EmptyDayEdition";
import { EditionStrip, editionSummary } from "@/components/newspaper/EditionStrip";
import { ReadingTips } from "@/components/newspaper/ReadingTips";
import { runningStageLabel } from "@/components/newspaper/editionStages";
import { tierForFrontPageRank } from "@/lib/gridTiers";
import { packGrid } from "@/lib/packGrid";
import { newRunCardIds } from "@/lib/newRun";
import { dateInTimeZone } from "@/lib/localDate";

// Stable reference so history pages (which never have pending entrances)
// pass the same value every render instead of minting a new Map. Nothing
// downstream is memoized today, so this changes no behavior — it just
// avoids a gratuitously unstable prop.
const EMPTY_ENTRANCES: Map<string, number> = new Map();
/** Stable no-op for non-interactive pages, which own no entrance state. */
const NOOP_ENTRANCE_PLAYED = () => {};
const NO_TITLES: string[] = [];

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
 * An empty day centres the trigger and shows the typesetting loader while
 * it runs (EmptyDayEdition); a day with cards pins a slim strip under the
 * topic bar that turns into a wire ticker (EditionStrip).
 * Replaces the generation half of the old (pre-4.4) Feed.tsx; the topic-tab
 * half is gone — topics are now real routes, navigated via TopicNav.
 */
export function FrontPage({
  initialDigest,
  userTopics,
  timeZone,
  interactive = true,
  basePath = "",
  firstEdition = false,
}: {
  initialDigest: Digest | null;
  userTopics: Topic[];
  /** The reader's stored timezone — "today" is their calendar day, the same one the server filed the digest under. */
  timeZone: string;
  /** false for a past /history/[date] front page — no generation trigger for a day that's already over. */
  interactive?: boolean;
  /** "/history/2026-08-01" when this is a past date's front page, so TopicNav's links stay scoped to that date. */
  basePath?: string;
  /** True when the reader has never had an edition, which adds the first-edition notice to an empty day. */
  firstEdition?: boolean;
}) {
  const prefersReducedMotion = useReducedMotion();
  const digestGen = useDigestGeneration();
  const todayKey = dateInTimeZone(new Date(), timeZone);

  // Only the live front page participates in the shared generation state —
  // a past /history/[date] front page (interactive=false) always has a
  // complete, static digest and never has a live generation to resume.
  const seeded = interactive && digestGen.seededDate === todayKey;

  const cards = seeded ? (digestGen.cards ?? []) : initialDigest?.cards;
  const loading = seeded ? digestGen.loading : false;
  const stageEvent = seeded ? digestGen.stageEvent : null;
  const wireTitles = seeded ? digestGen.wireTitles : NO_TITLES;
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

  const frontPageCards = cards ? frontPageCardsOf(cards) : [];

  return (
    <div className="flex flex-col">
      {/* One sticky band holding the topic bar and, on a live day with
          cards, the edition strip under it. Pinning the pair together
          means the strip needs no offset for the topic bar's height, which
          changes as its topics wrap. The band is the sticky element, so
          TopicNav isn't pinned on its own inside it. */}
      <div
        className="sticky z-10"
        style={{ top: "var(--masthead-height)", background: "var(--color-background)" }}
        data-testid="front-sticky-band"
      >
        {/* interactive=false is always a history front page, which always
            has a digest by construction — only gate on the live page's own
            reactive hasDigest state. */}
        <TopicNav
          topics={userTopics}
          basePath={basePath}
          digestExistsToday={interactive ? hasDigest : true}
          pinned={false}
        />
        {interactive && hasDigest && (
          <EditionStrip
            summary={editionSummary(cards, timeZone)}
            loading={loading}
            onStart={digestGen.startGeneration}
            stageEvent={stageEvent}
            titles={wireTitles}
            topicNames={userTopics}
            reducedMotion={prefersReducedMotion === true}
          />
        )}
      </div>

      {/* The run's one live region, mounted (empty) before any run starts:
          screen readers tend not to announce a region that appears with its
          text already in it. The loaders show the same sentence visually. */}
      {interactive && (
        <p role="status" aria-live="polite" className="sr-only" data-testid="edition-status">
          {loading ? runningStageLabel(stageEvent) : ""}
        </p>
      )}

      {interactive && hasDigest && error && (
        <p className="px-6 pt-3 text-center text-sm md:px-10" style={{ color: "var(--color-destructive)" }}>
          {error}
        </p>
      )}

      {interactive && !hasDigest && (
        <EmptyDayEdition
          loading={loading}
          onStart={digestGen.startGeneration}
          stageEvent={stageEvent}
          titles={wireTitles}
          topicNames={userTopics}
          // A run that finished with no cards still used one of the reader's
          // runs, so the "first edition" explanation no longer fits.
          firstEdition={firstEdition && digestGen.finishedRunDate !== todayKey}
          error={error}
          reducedMotion={prefersReducedMotion === true}
        />
      )}

      {interactive && hasDigest && <ReadingTips />}

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
                      : // EmptyDayEdition above already says so.
                        null
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
  /** Shown when there's genuinely nothing to render — judged after retention, not before. Null shows nothing. */
  emptyMessage: string | null;
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
    if (emptyMessage === null) return null;
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
