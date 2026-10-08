import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { getLatestGeneratedAtForUser, getTodayDigest } from "@/lib/digests";
import { FrontPage } from "@/components/newspaper/FrontPage";
import { TimeZoneSync } from "@/components/TimeZoneSync";

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

  const { topics, timeZone } = await getUserProfile(supabase, user.id);

  // Topics only: they define the digest. Zero preferred sources is a
  // finished profile that means "every source for my topics".
  if (topics.length === 0) {
    redirect("/onboarding");
  }

  const [digest, firstEdition] = await Promise.all([
    getTodayDigest(supabase, user.id, timeZone),
    // The latest generation stamp is non-null exactly when a run has ever
    // completed for this reader. Any failure only costs the first-edition
    // notice, so it reads as "has had one" rather than failing the page.
    (async () => (await getLatestGeneratedAtForUser(supabase, user.id)) === null)().catch(() => false),
  ]);

  return (
    <>
      <TimeZoneSync storedTimeZone={timeZone} />
      <FrontPage initialDigest={digest} userTopics={topics} timeZone={timeZone} firstEdition={firstEdition} />
    </>
  );
}
