import { LayoutGroup } from "motion/react";
import type { Card, Source, Topic } from "@/types";
import { TopicNav } from "@/components/newspaper/TopicNav";
import { PageGrid } from "@/components/newspaper/PageGrid";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";
import { tierForSeverity } from "@/lib/gridTiers";
import { packGrid } from "@/lib/packGrid";
import { newRunCardIds } from "@/lib/newRun";

// Distinct outlets, so a story carrying two articles from one preferred
// outlet doesn't outrank a story carrying two different preferred outlets.
function preferredSourceCount(card: Card, preferred: ReadonlySet<string>): number {
  return new Set(card.sources.map((s) => s.source).filter((source) => preferred.has(source))).size;
}

// Severity descending (box size), then more of the reader's preferred
// sources, then publishedAt desc + id — the front-page/topic-page ordering
// convention documented in docs/(C) IMPLEMENTATION_PLAN_4.4.md. The DB
// query (getCardsForTopicOnDate) only orders by recency, so severity
// ordering happens here. With no preferred sources every count is 0 and
// the preferred-source step never decides anything.
export function orderBySeverity(cards: Card[], preferredSources: readonly Source[] = []): Card[] {
  const preferred = new Set<string>(preferredSources);
  const counts = new Map(cards.map((card) => [card.id, preferredSourceCount(card, preferred)]));
  return [...cards].sort(
    (a, b) =>
      b.severity - a.severity ||
      (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) ||
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * One topic's stories for a given day — server-renderable (no client state
 * of its own; NewsCard manages its own bookmark/sources state). Reused for
 * both "today" and a specific /history/[date] via a date-scoped query, per
 * the 4.4 plan.
 */
export function TopicPage({
  cards,
  topic,
  userTopics,
  preferredSources = [],
  basePath = "",
  digestExistsToday = true,
}: {
  cards: Card[];
  topic: Topic;
  userTopics: Topic[];
  /** The reader's preferred sources: among cards of equal severity, more of them sorts first. */
  preferredSources?: readonly Source[];
  /** "/history/2026-08-01" when this is a past date's topic page, so TopicNav's links stay scoped to that date. */
  basePath?: string;
  /** False only on the live topic route before today's first digest exists — forwarded straight into TopicNav. Defaults true so history callers (which never pass this) stay ungated. */
  digestExistsToday?: boolean;
}) {
  const ordered = orderBySeverity(cards, preferredSources);
  const gridPositions = packGrid(
    ordered.map((card) => ({ id: card.id, tier: tierForSeverity(card.severity) }))
  );
  // Empty unless this topic's cards span 2+ runs — see newRun.ts. Scoped to
  // this page's own cards, so a later run that added nothing here badges
  // nothing here, even if it did add cards under other topics.
  const newRunIds = newRunCardIds(ordered);

  return (
    <div className="flex flex-col">
      <TopicNav
        topics={userTopics}
        activeTopic={topic}
        basePath={basePath}
        digestExistsToday={digestExistsToday}
      />

      <h1 className="px-6 py-6 font-heading text-3xl font-bold md:px-10">{topic}</h1>

      <div className="px-6 pb-10 md:px-10">
        {ordered.length === 0 ? (
          <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            {basePath ? `No notable ${topic} news that day.` : `No notable ${topic} news today.`}
          </p>
        ) : (
          // Scoped per page instance (topic + basePath) — see FrontPage.tsx's
          // identical comment (Phase 6.5): prevents Motion's shared-layout
          // registry from connecting a card here to the same card.id's
          // layoutId on a different page (e.g. this card also appearing on
          // the front page's top-6).
          <LayoutGroup id={`topic-${topic}-${basePath || "today"}`}>
            <FocusModeProvider>
              <PageGrid>
                {ordered.map((card) => (
                  <NewsCard
                    key={card.id}
                    card={card}
                    tier={tierForSeverity(card.severity)}
                    gridPosition={gridPositions.get(card.id)}
                    showTopicBadge={false}
                    showNewBadge={newRunIds.has(card.id)}
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
