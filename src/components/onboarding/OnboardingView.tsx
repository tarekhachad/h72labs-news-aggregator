"use client";

import { PreferencesForm } from "@/components/PreferencesForm";
import { OnboardingHeader } from "@/components/onboarding/OnboardingHeader";
import { OnboardingStepProvider } from "@/components/onboarding/OnboardingStepContext";
import type { PreferencesState } from "@/lib/profileErrors";

/** The onboarding page's body: the header and the stepped form. The dev fixture page renders it too, with a no-op action. */
export function OnboardingView({
  action,
}: {
  action: (previous: PreferencesState | void, formData: FormData) => Promise<PreferencesState | void>;
}) {
  return (
    <OnboardingStepProvider>
      <div className="min-h-screen">
        <OnboardingHeader />
        <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
          <div>
            <h1 className="text-2xl font-semibold">Set up your briefing</h1>
            <p className="mt-2 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
              Pick the topics your daily paper is built from, then any countries and outlets you&apos;d like.
            </p>
          </div>
          <PreferencesForm stepped action={action} submitLabel="Save and continue" />
        </main>
      </div>
    </OnboardingStepProvider>
  );
}
