import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserProfile } from "@/lib/profile";
import { PreferencesForm } from "@/components/PreferencesForm";
import { FEEDS } from "@/config/feeds";
import { COUNTRY_FEEDS } from "@/config/countries";
import { buildSourceCoverage } from "@/lib/sourceCoverage";
import { SubmitButton } from "@/components/SubmitButton";
import { PasswordInput } from "@/components/PasswordInput";
import { updatePreferences, changePassword } from "./actions";
import { TimeZoneSync } from "@/components/TimeZoneSync";
import { CHANGE_PASSWORD_ERROR_MESSAGES, isChangePasswordErrorCode } from "@/lib/authErrors";

const PASSWORD_FIELD_CLASS = "rounded-xl px-3 py-2 text-sm";

const PASSWORD_FIELD_STYLE = {
  border: "1px solid var(--color-border)",
  background: "var(--color-card)",
  color: "var(--color-card-foreground)",
} as const;

// Built here, on the server: the form gets outlet, topic and country names, never a feed URL.
const SOURCE_COVERAGE = buildSourceCoverage(FEEDS, COUNTRY_FEEDS);

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{
    prefsSaved?: string;
    pwError?: string;
    pwSaved?: string;
  }>;
}) {
  const { prefsSaved, pwError, pwSaved } = await searchParams;
  const pwErrorMessage = isChangePasswordErrorCode(pwError) ? CHANGE_PASSWORD_ERROR_MESSAGES[pwError] : null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The proxy (middleware) already gates unauthenticated requests before
  // they reach here — this is defense-in-depth, not the primary check.
  if (!user) {
    redirect("/login");
  }

  const { topics, preferredSources, countries, timeZone } = await getUserProfile(supabase, user.id);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-12 px-6 py-16">
      <TimeZoneSync storedTimeZone={timeZone} />
      <section className="flex flex-col gap-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Edit your briefing</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            Update the topics and sources your daily digest is built from.
          </p>
          <p className="mt-1 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            Changes apply from your next run, and today&apos;s cards stay. A topic or country you add gets a full
            first edition the next time you press &ldquo;Complete today&apos;s news&rdquo;.
          </p>
        </div>

        <PreferencesForm
          action={updatePreferences}
          defaultTopics={topics}
          defaultCountries={countries}
          defaultSources={preferredSources}
          sourceCoverage={SOURCE_COVERAGE}
          submitLabel="Save preferences"
          savedMessage={prefsSaved ? "Preferences saved." : undefined}
        />
      </section>

      <section
        className="flex flex-col gap-4 border-t pt-12"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="text-center">
          <h2 className="text-lg font-semibold">Change password</h2>
        </div>

        <form action={changePassword} className="mx-auto flex w-full max-w-sm flex-col gap-3">
          <PasswordInput
            name="currentPassword"
            placeholder="Current password"
            autoComplete="current-password"
            required
            className={PASSWORD_FIELD_CLASS}
            style={PASSWORD_FIELD_STYLE}
          />
          <PasswordInput
            name="newPassword"
            placeholder="New password"
            autoComplete="new-password"
            showRule
            className={PASSWORD_FIELD_CLASS}
            style={PASSWORD_FIELD_STYLE}
          />
          <PasswordInput
            name="confirmPassword"
            placeholder="Confirm new password"
            autoComplete="new-password"
            className={PASSWORD_FIELD_CLASS}
            style={PASSWORD_FIELD_STYLE}
          />

          {pwErrorMessage && (
            <p className="text-center text-sm" style={{ color: "var(--color-destructive)" }}>
              {pwErrorMessage}
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
