"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { SOURCES, TOPICS } from "@/types";

const ProfileInput = z.object({
  topics: z.array(z.enum(TOPICS)).min(1, "Pick at least one topic"),
  preferredSources: z.array(z.enum(SOURCES)).min(1, "Pick at least one source"),
});

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

  // Replace the whole preference set (delete-then-insert), not in-place
  // edits — matches the RLS design (no UPDATE policy) and means this
  // action doubles as an "edit preferences" flow later with no changes.
  // Every step's error is checked — if delete succeeds but insert fails,
  // silently proceeding would leave the user with zero saved preferences
  // and no explanation (page.tsx would just bounce them back here with
  // nothing telling them why).
  const [deleteTopics, deleteSources] = await Promise.all([
    supabase.from("user_topics").delete().eq("user_id", user.id),
    supabase.from("user_preferred_sources").delete().eq("user_id", user.id),
  ]);
  if (deleteTopics.error || deleteSources.error) {
    redirect(`/onboarding?error=${encodeURIComponent("Couldn't save your preferences — try again.")}`);
  }

  const [insertTopics, insertSources] = await Promise.all([
    supabase.from("user_topics").insert(topics.map((topic) => ({ user_id: user.id, topic }))),
    supabase
      .from("user_preferred_sources")
      .insert(preferredSources.map((source) => ({ user_id: user.id, source }))),
  ]);
  if (insertTopics.error || insertSources.error) {
    redirect(`/onboarding?error=${encodeURIComponent("Couldn't save your preferences — try again.")}`);
  }

  redirect("/");
}
