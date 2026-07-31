import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getDigestForDate } from "@/lib/digests";
import { TOPICS, type Topic } from "@/types";
import { CardItem } from "@/components/CardItem";

// Canonical TOPICS order, filtered to the topics actually present in this
// digest — same convention as Feed.tsx's tab ordering.
function orderTopics(topics: Topic[]): Topic[] {
  const present = new Set(topics);
  return TOPICS.filter((t) => present.has(t));
}

// Reject anything that isn't a plain YYYY-MM-DD before it reaches the DB
// query — an unvalidated value (e.g. someone typing a garbage URL) would
// otherwise make Postgres throw an invalid-date-format error, surfacing as
// a generic 500 instead of the page's existing "no digest" empty state.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export default async function HistoryDatePage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The proxy (middleware) already gates unauthenticated requests before
  // they reach here — this is defense-in-depth, not the primary check.
  if (!user) {
    redirect("/login");
  }

  const digest = DATE_PATTERN.test(date)
    ? await getDigestForDate(supabase, user.id, date)
    : null;
  const topics = digest ? orderTopics(digest.cards.map((c) => c.topic)) : [];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
        <Link
          href="/history"
          className="text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← Back to history
        </Link>

        <h1 className="text-center text-2xl font-semibold text-black dark:text-zinc-50">
          {date}
        </h1>

        {!digest || digest.cards.length === 0 ? (
          <p className="text-center text-sm text-zinc-500">No digest for this date.</p>
        ) : (
          <div className="flex flex-col gap-8">
            {topics.map((topic) => {
              const topicCards = digest.cards.filter((c) => c.topic === topic);
              if (topicCards.length === 0) return null;
              return (
                <div key={topic} className="flex flex-col gap-4">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {topic}
                  </h2>
                  {topicCards.map((card) => (
                    <CardItem key={card.id} card={card} />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
