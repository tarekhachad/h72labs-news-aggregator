import type { Card, Topic } from "@/types";
import { TopicNavBox } from "@/components/newspaper/TopicNavBox";
import { PageGrid } from "@/components/newspaper/PageGrid";
import { NewsCard } from "@/components/newspaper/NewsCard";
import { FocusModeProvider } from "@/components/newspaper/FocusModeContext";
import { tierForSeverity } from "@/lib/gridTiers";
import { packGrid } from "@/lib/packGrid";

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
}: {
  cards: Card[];
  topic: Topic;
  userTopics: Topic[];
  /** "/history/2026-08-01" when this is a past date's topic page, so TopicNavBox's links stay scoped to that date. */
  basePath?: string;
}) {
  const ordered = orderBySeverity(cards);
  const gridPositions = packGrid(
    ordered.map((card) => ({ id: card.id, tier: tierForSeverity(card.severity) }))
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-6 py-6 md:px-10">
        <h1 className="font-heading text-3xl font-bold">{topic}</h1>
        <TopicNavBox topics={userTopics} activeTopic={topic} basePath={basePath} />
      </div>

      <div className="px-6 pb-10 md:px-10">
        {ordered.length === 0 ? (
          <p className="text-center text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            {basePath ? `No notable ${topic} news that day.` : `No notable ${topic} news today.`}
          </p>
        ) : (
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
            </PageGrid>
          </FocusModeProvider>
        )}
      </div>
    </div>
  );
}
