import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { TimeZoneSync } from "@/components/TimeZoneSync";
import { OnboardingView } from "@/components/onboarding/OnboardingView";
import { SourceCoverageProvider } from "@/components/PreferencesForm";
import { FEEDS } from "@/config/feeds";
import { COUNTRY_FEEDS } from "@/config/countries";
import { buildSourceCoverage } from "@/lib/sourceCoverage";
import { saveProfile } from "./actions";

// Built here, on the server: the form gets outlet, topic and country names, never a feed URL.
const SOURCE_COVERAGE = buildSourceCoverage(FEEDS, COUNTRY_FEEDS);

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The proxy already sends a signed-out visit to /login; this is
  // defense-in-depth, as on the newspaper pages.
  if (!user) {
    redirect("/login");
  }

  const { topics, timeZone } = await getUserProfile(supabase, user.id);

  // A reader who already has topics edits them on /profile. Showing them a
  // blank form here would let a stray visit save over their profile.
  if (topics.length > 0) {
    redirect("/profile");
  }

  return (
    <>
      <TimeZoneSync storedTimeZone={timeZone} />
      <SourceCoverageProvider coverage={SOURCE_COVERAGE}>
        <OnboardingView action={saveProfile} />
      </SourceCoverageProvider>
    </>
  );
}
