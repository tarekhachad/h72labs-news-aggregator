import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { getCardsForTopicOnDate, todayDateString } from "@/lib/digests";
import { slugToTopic } from "@/lib/topicSlug";
import { TopicPage } from "@/components/newspaper/TopicPage";
import { TimeZoneSync } from "@/components/TimeZoneSync";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export default async function HistoryTopicPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string; slug: string }>;
  /** `country` filters the Countries page; see TopicPage. */
  searchParams?: Promise<{ country?: string | string[] }>;
}) {
  const { date, slug } = await params;
  const topic = slugToTopic(slug);
  if (!topic) {
    redirect("/history");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { topics, preferredSources, timeZone } = await getUserProfile(supabase, user.id);
  if (topics.length === 0) {
    redirect("/onboarding");
  }

  const country = (await searchParams)?.country;

  // Today isn't history — same guard as the sibling /history/[date] route,
  // sending the reader to the live topic page instead of a duplicate
  // non-interactive one. Deliberately after the slug check above, so a bad
  // slug still lands on /history rather than being redirected to a live
  // topic route that doesn't exist either.
  if (date === todayDateString(timeZone)) {
    redirect(
      typeof country === "string" && country !== ""
        ? `/topic/${slug}?country=${encodeURIComponent(country)}`
        : `/topic/${slug}`
    );
  }

  const cards = DATE_PATTERN.test(date)
    ? await getCardsForTopicOnDate(supabase, user.id, date, topic)
    : [];

  return (
    <>
      <TimeZoneSync storedTimeZone={timeZone} />
      <TopicPage
        cards={cards}
        topic={topic}
        userTopics={topics}
        preferredSources={preferredSources}
        country={typeof country === "string" ? country : undefined}
        basePath={`/history/${date}`}
      />
    </>
  );
}
