import { PreferencesForm } from "@/components/PreferencesForm";
import { saveProfile } from "./actions";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Set up your briefing</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            Pick the topics and sources you want your daily digest built from.
          </p>
        </div>

        <PreferencesForm action={saveProfile} submitLabel="Save and continue" error={error} />
      </main>
    </div>
  );
}
