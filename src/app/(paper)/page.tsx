import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { getTodayDigest } from "@/lib/digests";
import { FrontPage } from "@/components/newspaper/FrontPage";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The proxy (middleware) already gates unauthenticated requests before
  // they reach here — this is defense-in-depth, not the primary check.
  if (!user) {
    redirect("/login");
  }

  const { topics, preferredSources } = await getUserProfile(supabase, user.id);

  // Gate on both — a profile with topics but zero preferred sources would
  // otherwise pass this check and then silently produce an empty digest
  // forever (ingestArticles filters strictly by preferred source).
  if (topics.length === 0 || preferredSources.length === 0) {
    redirect("/onboarding");
  }

  const digest = await getTodayDigest(supabase, user.id);

  return <FrontPage initialDigest={digest} userTopics={topics} />;
}
