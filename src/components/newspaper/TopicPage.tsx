import { LayoutGroup } from "motion/react";
import type { Card, Topic } from "@/types";
import { TopicNav } from "@/components/newspaper/TopicNav";
import { PageGrid } from "@/components/newspaper/PageGrid";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { RunDivider } from "@/components/newspaper/RunDivider";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";
import { tierForSeverity } from "@/lib/gridTiers";
import { packGridWithRunDividers } from "@/lib/packGrid";

// Severity descending (box size), tiebreak publishedAt desc + id — matches
// the front-page/topic-page ordering convention documented in
// docs/(C) IMPLEMENTATION_PLAN_4.4.md. The DB query (getCardsForTopicOnDate)
// only orders by recency, so severity ordering happens here.
function orderBySeverity(cards: Card[]): Card[] {
  return [...cards].sort(
    (a, b) =>
      b.severity - a.severity ||
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
  basePath = "",
  digestExistsToday = true,
}: {
  cards: Card[];
  topic: Topic;
  userTopics: Topic[];
  /** "/history/2026-08-01" when this is a past date's topic page, so TopicNav's links stay scoped to that date. */
  basePath?: string;
  /** False only on the live topic route before today's first digest exists — forwarded straight into TopicNav. Defaults true so history callers (which never pass this) stay ungated. */
  digestExistsToday?: boolean;
}) {
  const ordered = orderBySeverity(cards);
  const { gridPositions, dividers } = packGridWithRunDividers(
    ordered.map((card) => ({ id: card.id, tier: tierForSeverity(card.severity), generatedAt: card.generatedAt }))
  );

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
                  />
                ))}
                {dividers.map((d) => (
                  // Keyed on gridRow, not generatedAt — see FrontPage.tsx's
                  // identical comment: interleaved runs can share a
                  // generatedAt across more than one divider, gridRow can't.
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
