import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { getCardsForTopicOnDate, digestExistsForDate, todayDateString } from "@/lib/digests";
import { slugToTopic } from "@/lib/topicSlug";
import { TopicPage } from "@/components/newspaper/TopicPage";
import { TimeZoneSync } from "@/components/TimeZoneSync";
import { CountryFactsPanel } from "@/components/newspaper/panels/CountryFactsPanel";
import { filteredCountry } from "@/lib/panels/filteredCountry";
import { RatesStripPanel } from "@/components/newspaper/panels/RatesStripPanel";
import type { Topic } from "@/types";

const MARKETS_TOPIC: Topic = "Markets & Investing";

export default async function TopicRoutePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  /** `country` filters the Countries page; see TopicPage. */
  searchParams?: Promise<{ country?: string | string[] }>;
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

  const { topics, preferredSources, timeZone } = await getUserProfile(supabase, user.id);
  // Matches Home's gate — a direct hit on this route (stale bookmark, typed
  // URL) before onboarding is complete would otherwise show a misleading
  // empty "no notable news" page instead of routing to setup.
  if (topics.length === 0) {
    redirect("/onboarding");
  }

  const today = todayDateString(timeZone);
  const [cards, digestExistsToday] = await Promise.all([
    getCardsForTopicOnDate(supabase, user.id, today, topic),
    // Fail-open (defaults to ungated on a transient error): this check only
    // affects whether sibling topic links are greyed out, a cosmetic
    // affordance — matching this project's existing fail-open convention
    // (rank.ts, dedup.ts) rather than letting a purely cosmetic check sink
    // the whole page render.
    digestExistsForDate(supabase, user.id, today).catch(() => true),
  ]);

  const countryParam = (await searchParams)?.country;
  const country = typeof countryParam === "string" ? countryParam : undefined;
  // Today's page only: history topic pages show no panel.
  const factsCountry = filteredCountry(topic, cards, country);
  const panel = factsCountry ? (
    <CountryFactsPanel country={factsCountry} />
  ) : topic === MARKETS_TOPIC ? (
    <RatesStripPanel />
  ) : undefined;

  return (
    <>
      <TimeZoneSync storedTimeZone={timeZone} />
      <TopicPage
        cards={cards}
        topic={topic}
        userTopics={topics}
        preferredSources={preferredSources}
        country={country}
        digestExistsToday={digestExistsToday}
        panel={panel}
      />
    </>
  );
}
