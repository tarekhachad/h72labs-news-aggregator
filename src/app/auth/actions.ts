"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { INVITE_TOKEN_PATTERN, signupErrorCode, type SignupErrorCode } from "@/lib/invite";
import { loginErrorCode } from "@/lib/authErrors";
import { RECOVERY_COOKIE, recoverySecret, verifyRecoveryMarker } from "@/lib/recoveryMarker";

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
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    // Becomes user_metadata.invite_token, which is where the
    // before-user-created hook reads it.
    options: { data: { invite_token: invite } },
  });

  if (error) {
    signupRedirect(invite, signupErrorCode(error.message));
  }

  // With email confirmation on there is no session yet, so /onboarding — which
  // requires one — would bounce straight back to /login. An address that
  // already has an account also lands here, with no session and no email sent,
  // which is what keeps this page from confirming who is registered.
  if (!data?.session) {
    const params = new URLSearchParams({ email: parsed.data.email });
    redirect(`/signup/check-email?${params.toString()}`);
  }

  redirect("/onboarding");
}

/**
 * Sends the confirmation email again. The invite token was already spent at
 * account creation, so this — not a fresh invite — is how someone who never
 * clicked the first link finishes signing up.
 */
export async function resendConfirmation(formData: FormData) {
  const email = z.string().email().safeParse(formData.get("email"));
  if (email.success) {
    const supabase = await createClient();
    await supabase.auth.resend({ type: "signup", email: email.data });
  }

  // Always the same redirect, whatever happened above: a different answer for
  // a registered address would turn this form into an account checker.
  redirect("/signup/check-email?sent=1");
}

export async function requestPasswordReset(formData: FormData) {
  const email = z.string().email().safeParse(formData.get("email"));
  if (email.success) {
    const supabase = await createClient();
    await supabase.auth.resetPasswordForEmail(email.data);
  }

  redirect("/forgot-password?sent=1");
}

/**
 * Sets a new password from a verified reset link, then signs the account out
 * everywhere else. The eviction is what makes a reset useful against a stolen
 * session, and it is only safe because the marker proves the reset link was
 * opened: a session alone can't reach this code.
 */
export async function resetPassword(formData: FormData) {
  const supabase = await createClient();
  const cookieStore = await cookies();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId || !verifyRecoveryMarker(cookieStore.get(RECOVERY_COOKIE)?.value, userId, recoverySecret())) {
    redirect("/forgot-password?expired=1");
  }

  const password = z.string().min(6).safeParse(formData.get("password"));
  if (!password.success) {
    redirect("/reset-password?error=weak_password");
  }

  const { error } = await supabase.auth.updateUser({ password: password.data });
  if (error) {
    redirect(`/reset-password?error=${error.code === "same_password" ? "same_password" : "reset_failed"}`);
  }

  // Single use: the marker must not reopen the form after the reset landed.
  cookieStore.delete(RECOVERY_COOKIE);

  const { error: evictError } = await supabase.auth.signOut({ scope: "others" });
  if (evictError) {
    // The password is already changed, so the user is not sent back to a
    // form that would fail again. The log is what shows eviction didn't run.
    console.error("[resetPassword] signing out other sessions failed:", evictError);
  }

  redirect("/");
}

export async function signIn(formData: FormData) {
  const parsed = Credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    redirect(`/login?error=${field === "email" ? "invalid_email" : "invalid_credentials"}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    redirect(`/login?error=${loginErrorCode(error)}`);
  }

  redirect("/");
}

export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
