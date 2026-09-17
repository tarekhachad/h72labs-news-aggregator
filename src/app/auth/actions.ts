"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { INVITE_TOKEN_PATTERN, signupErrorCode, type SignupErrorCode } from "@/lib/invite";

// A missing field or a submitted File (not a string) would otherwise
// surface as an opaque Supabase API error instead of a clean local one.
const Credentials = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

function signupRedirect(invite: string, code: SignupErrorCode): never {
  const params = new URLSearchParams({ invite, error: code });
  redirect(`/signup?${params.toString()}`);
}

export async function signUp(formData: FormData) {
  const rawInvite = formData.get("invite");
  const invite = typeof rawInvite === "string" ? rawInvite : "";
  // A malformed token can't match any invite, so it is rejected here without
  // a round-trip. This is a shortcut, not the gate: the hook rejects it too.
  if (!INVITE_TOKEN_PATTERN.test(invite)) {
    redirect(`/signup?error=${invite ? "invite_invalid" : "invite_required"}`);
  }

  const parsed = Credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    signupRedirect(invite, field === "password" ? "weak_password" : "invalid_email");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    ...parsed.data,
    // Becomes user_metadata.invite_token, which is where the
    // before-user-created hook reads it.
    options: { data: { invite_token: invite } },
  });

  if (error) {
    signupRedirect(invite, signupErrorCode(error.message));
  }

  redirect("/onboarding");
}

export async function signIn(formData: FormData) {
  const parsed = Credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/login?error=${encodeURIComponent(message)}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/");
}

export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
