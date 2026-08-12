import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { getDigestForDate, todayDateString } from "@/lib/digests";
import { FrontPage } from "@/components/newspaper/FrontPage";

// Reject anything that isn't a plain YYYY-MM-DD before it reaches the DB
// query — an unvalidated value would otherwise surface as a generic
// Postgres error instead of the page's own "no digest" empty state.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The full newspaper front page for a past date — reuses FrontPage exactly
 * as "today" does, just parameterized by date and non-interactive (no
 * generation trigger for a day that's already over). Because front-page
 * ranking is cumulative (rank.ts re-ranks the full pool every run and
 * writes the result back), the persisted frontPageRank values already are
 * that day's final arrangement — no separate snapshot mechanism needed.
 */
export default async function HistoryDatePage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;

  // Today isn't history (Phase 8.1). listDigestDatesForUser no longer
  // surfaces today's date, but this route is still directly reachable by
  // a typed URL or a link bookmarked yesterday — without this it would
  // render a second, non-interactive copy of the front page, missing the
  // generation trigger. Redirect rather than 404: the content the URL is
  // asking for genuinely exists, just at "/".
  if (date === todayDateString()) {
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
  if (topics.length === 0 || preferredSources.length === 0) {
    redirect("/onboarding");
  }

  const digest = DATE_PATTERN.test(date)
    ? await getDigestForDate(supabase, user.id, date)
    : null;

  return (
    <FrontPage
      initialDigest={digest}
      userTopics={topics}
      interactive={false}
      basePath={`/history/${date}`}
    />
  );
}
