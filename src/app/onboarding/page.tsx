import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { TimeZoneSync } from "@/components/TimeZoneSync";
import { OnboardingView } from "@/components/onboarding/OnboardingView";
import { saveProfile } from "./actions";

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
      <OnboardingView action={saveProfile} />
    </>
  );
}
