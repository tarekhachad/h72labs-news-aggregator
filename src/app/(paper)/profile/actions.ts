"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { ProfileInput, saveUserProfile } from "@/lib/profile";

export async function updatePreferences(formData: FormData) {
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
    redirect(`/profile?prefsError=${encodeURIComponent(message)}`);
  }

  const { topics, preferredSources } = parsed.data;

  const { error } = await saveUserProfile(supabase, user.id, topics, preferredSources);
  if (error) {
    // If this leaves the user with an empty preference set, the home page's
    // own gate (topics.length === 0) will bounce them to /onboarding instead
    // of back here — pre-existing behavior of the shared delete-then-insert
    // path, not something this action can fix on its own.
    redirect(`/profile?prefsError=${encodeURIComponent(error)}`);
  }

  redirect("/profile?prefsSaved=1");
}

const PasswordInput = z
  .object({
    newPassword: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export async function changePassword(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const parsed = PasswordInput.safeParse({
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/profile?pwError=${encodeURIComponent(message)}`);
  }

  // No current-password reauth: Supabase's updateUser trusts the request's
  // existing session, and no reauth pattern exists elsewhere in this app.
  // An active/hijacked session could change the password without proving
  // knowledge of the old one — accepted trade-off for a personal reader.
  const { error } = await supabase.auth.updateUser({ password: parsed.data.newPassword });
  if (error) {
    redirect(`/profile?pwError=${encodeURIComponent(error.message)}`);
  }

  redirect("/profile?pwSaved=1");
}
