"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProfileInput, saveUserProfile } from "@/lib/profile";
import { changePasswordErrorCode, type ChangePasswordErrorCode } from "@/lib/authErrors";

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
    countries: formData.getAll("countries"),
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid selection";
    redirect(`/profile?prefsError=${encodeURIComponent(message)}`);
  }

  const { topics, preferredSources, countries } = parsed.data;

  const { error } = await saveUserProfile(supabase, user.id, topics, preferredSources, countries);
  if (error) {
    // A failure after the delete can leave the user with no saved topics;
    // the page gates (topics.length === 0) then send them to /onboarding
    // rather than back here. Zero sources alone never does: it is a valid
    // profile. Fixing the topics case needs an atomic save, which the shared
    // delete-then-insert path doesn't have.
    redirect(`/profile?prefsError=${encodeURIComponent(error)}`);
  }

  redirect("/profile?prefsSaved=1");
}

function passwordRedirect(code: ChangePasswordErrorCode): never {
  redirect(`/profile?pwError=${code}`);
}

export async function changePassword(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const currentPassword = formData.get("currentPassword");
  const newPassword = formData.get("newPassword");
  const confirmPassword = formData.get("confirmPassword");

  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    passwordRedirect("current_password_required");
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    passwordRedirect("weak_password");
  }
  if (newPassword !== confirmPassword) {
    passwordRedirect("password_mismatch");
  }

  // A session alone must not be enough to take over the account. Auth checks
  // current_password itself when "Require current password when changing
  // password" is on in the dashboard, which also covers a stolen token calling
  // the Auth endpoint directly, where no check in this file would run.
  const { error } = await supabase.auth.updateUser({
    password: newPassword,
    current_password: currentPassword,
  });
  if (error) {
    passwordRedirect(changePasswordErrorCode(error));
  }

  redirect("/profile?pwSaved=1");
}
