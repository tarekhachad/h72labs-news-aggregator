import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { getCardsForTopicOnDate, todayDateString } from "@/lib/digests";
import { slugToTopic } from "@/lib/topicSlug";
import { TopicPage } from "@/components/newspaper/TopicPage";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export default async function HistoryTopicPage({
  params,
}: {
  params: Promise<{ date: string; slug: string }>;
}) {
  const { date, slug } = await params;
  const topic = slugToTopic(slug);
  if (!topic) {
    redirect("/history");
  }

  // Today isn't history (Phase 8.1) — same guard as the sibling
  // /history/[date] route, sending the reader to the live topic page
  // instead of a duplicate non-interactive one. Deliberately after the
  // slug check above, so a bad slug still lands on /history rather than
  // being redirected to a live topic route that doesn't exist either.
  if (date === todayDateString()) {
    redirect(`/topic/${slug}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { topics, preferredSources } = await getUserProfile(supabase, user.id);
  if (topics.length === 0 || preferredSources.length === 0) {
    redirect("/onboarding");
  }

  const cards = DATE_PATTERN.test(date)
    ? await getCardsForTopicOnDate(supabase, user.id, date, topic)
    : [];

  return (
    <TopicPage cards={cards} topic={topic} userTopics={topics} basePath={`/history/${date}`} />
  );
}
