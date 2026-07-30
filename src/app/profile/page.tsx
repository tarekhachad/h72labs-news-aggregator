import { redirect } from "next/navigation";
import Link from "next/link";
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
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex max-w-2xl flex-col gap-12 px-6 py-16">
        <Link
          href="/"
          className="text-xs font-medium text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          ← Back
        </Link>

        <section className="flex flex-col gap-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
              Edit your briefing
            </h1>
            <p className="mt-2 text-sm text-zinc-500">
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
            <p className="text-center text-sm text-green-600">Preferences saved.</p>
          )}
        </section>

        <section className="flex flex-col gap-4 border-t border-zinc-200 pt-12 dark:border-zinc-800">
          <div className="text-center">
            <h2 className="text-lg font-semibold text-black dark:text-zinc-50">
              Change password
            </h2>
          </div>

          <form action={changePassword} className="mx-auto flex w-full max-w-sm flex-col gap-3">
            <input
              type="password"
              name="newPassword"
              placeholder="New password"
              autoComplete="new-password"
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
            />
            <input
              type="password"
              name="confirmPassword"
              placeholder="Confirm new password"
              autoComplete="new-password"
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
            />

            {pwError && <p className="text-center text-sm text-red-600">{pwError}</p>}
            {pwSaved && <p className="text-center text-sm text-green-600">Password updated.</p>}

            <SubmitButton className="cursor-pointer self-center rounded-full bg-black px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-black dark:hover:bg-zinc-200">
              Update password
            </SubmitButton>
          </form>
        </section>
      </main>
    </div>
  );
}
