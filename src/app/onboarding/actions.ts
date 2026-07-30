"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProfileInput, saveUserProfile } from "@/lib/profile";

export async function saveProfile(formData: FormData) {
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
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid selection";
    redirect(`/onboarding?error=${encodeURIComponent(message)}`);
  }

  const { topics, preferredSources } = parsed.data;

  const { error } = await saveUserProfile(supabase, user.id, topics, preferredSources);
  if (error) {
    redirect(`/onboarding?error=${encodeURIComponent(error)}`);
  }

  redirect("/");
}
