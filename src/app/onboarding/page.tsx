import { PreferencesForm } from "@/components/PreferencesForm";
import { saveProfile } from "./actions";

export default function OnboardingPage() {
  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Set up your briefing</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            Pick the topics your daily digest is built from, and any sources you prefer.
          </p>
        </div>

        <PreferencesForm action={saveProfile} submitLabel="Save and continue" />
      </main>
    </div>
  );
}
