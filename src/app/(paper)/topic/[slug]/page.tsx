import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { getCardsForTopicOnDate, digestExistsForDate, todayDateString } from "@/lib/digests";
import { slugToTopic } from "@/lib/topicSlug";
import { TopicPage } from "@/components/newspaper/TopicPage";

export default async function TopicRoutePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const topic = slugToTopic(slug);
  // An unrecognized slug (bad link, stale bookmark) redirects to the front
  // page rather than 404ing — matches the plan's "invalid slugs redirect
  // to /" call.
  if (!topic) {
    redirect("/");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { topics, preferredSources } = await getUserProfile(supabase, user.id);
  // Matches Home's gate — a direct hit on this route (stale bookmark, typed
  // URL) before onboarding is complete would otherwise show a misleading
  // empty "no notable news" page instead of routing to setup.
  if (topics.length === 0 || preferredSources.length === 0) {
    redirect("/onboarding");
  }

  const today = todayDateString();
  const [cards, digestExistsToday] = await Promise.all([
    getCardsForTopicOnDate(supabase, user.id, today, topic),
    // Fail-open (defaults to ungated on a transient error): this check only
    // affects whether sibling topic links are greyed out, a cosmetic
    // affordance — matching this project's existing fail-open convention
    // (rank.ts, dedup.ts) rather than letting a purely cosmetic check sink
    // the whole page render.
    digestExistsForDate(supabase, user.id, today).catch(() => true),
  ]);

  return (
    <TopicPage
      cards={cards}
      topic={topic}
      userTopics={topics}
      digestExistsToday={digestExistsToday}
    />
  );
}
