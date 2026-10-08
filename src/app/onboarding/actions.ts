"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProfileInput, saveUserProfile } from "@/lib/profile";
import { profileErrorCode, type PreferencesState } from "@/lib/profileErrors";

// A refusal is returned rather than redirected, so the form keeps the
// reader's picks and shows the code's fixed message.
export async function saveProfile(_previous: unknown, formData: FormData): Promise<PreferencesState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const parsed = ProfileInput.safeParse({
    topics: formData.getAll("topics"),
    preferredSources: formData.getAll("preferredSources"),
    countries: formData.getAll("countries"),
  });

  if (!parsed.success) {
    return { error: profileErrorCode(parsed.error.issues) };
  }

  const { topics, preferredSources, countries } = parsed.data;

  const { error } = await saveUserProfile(supabase, user.id, topics, preferredSources, countries);
  if (error) {
    return { error: "save_failed" };
  }

  redirect("/");
}
