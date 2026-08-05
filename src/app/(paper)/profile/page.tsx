import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { PreferencesForm } from "@/components/PreferencesForm";
import { SubmitButton } from "@/components/SubmitButton";
import { updatePreferences, changePassword } from "./actions";

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{
    prefsError?: string;
    prefsSaved?: string;
    pwError?: string;
    pwSaved?: string;
  }>;
}) {
  const { prefsError, prefsSaved, pwError, pwSaved } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The proxy (middleware) already gates unauthenticated requests before
  // they reach here — this is defense-in-depth, not the primary check.
  if (!user) {
    redirect("/login");
  }

  const { topics, preferredSources } = await getUserProfile(supabase, user.id);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-12 px-6 py-16">
      <section className="flex flex-col gap-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Edit your briefing</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            Update the topics and sources your daily digest is built from.
          </p>
        </div>

        <PreferencesForm
          action={updatePreferences}
          defaultTopics={topics}
          defaultSources={preferredSources}
          submitLabel="Save preferences"
          error={prefsError}
        />
        {prefsSaved && (
          <p className="text-center text-sm" style={{ color: "#166534" }}>
            Preferences saved.
          </p>
        )}
      </section>

      <section
        className="flex flex-col gap-4 border-t pt-12"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="text-center">
          <h2 className="text-lg font-semibold">Change password</h2>
        </div>

        <form action={changePassword} className="mx-auto flex w-full max-w-sm flex-col gap-3">
          <input
            type="password"
            name="newPassword"
            placeholder="New password"
            autoComplete="new-password"
            className="rounded-xl px-3 py-2 text-sm"
            style={{
              border: "1px solid var(--color-border)",
              background: "var(--color-card)",
              color: "var(--color-card-foreground)",
            }}
          />
          <input
            type="password"
            name="confirmPassword"
            placeholder="Confirm new password"
            autoComplete="new-password"
            className="rounded-xl px-3 py-2 text-sm"
            style={{
              border: "1px solid var(--color-border)",
              background: "var(--color-card)",
              color: "var(--color-card-foreground)",
            }}
          />

          {pwError && (
            <p className="text-center text-sm" style={{ color: "var(--color-destructive)" }}>
              {pwError}
            </p>
          )}
          {pwSaved && (
            <p className="text-center text-sm" style={{ color: "#166534" }}>
              Password updated.
            </p>
          )}

          <SubmitButton
            className="cursor-pointer self-center rounded-full px-8 py-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: "var(--color-primary)", color: "var(--color-on-primary)" }}
          >
            Update password
          </SubmitButton>
        </form>
      </section>
    </main>
  );
}
