import { TOPICS, SOURCES } from "@/types";
import { saveProfile } from "./actions";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Set up your briefing
          </h1>
          <p className="mt-2 text-sm text-zinc-500">
            Pick the topics and sources you want your daily digest built from.
          </p>
        </div>

        <form action={saveProfile} className="flex flex-col gap-8">
          <fieldset>
            <legend className="mb-3 text-sm font-medium text-black dark:text-zinc-50">
              Topics
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {TOPICS.map((topic) => (
                <label
                  key={topic}
                  className="flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
                >
                  <input type="checkbox" name="topics" value={topic} className="cursor-pointer" />
                  {topic}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-3 text-sm font-medium text-black dark:text-zinc-50">
              Preferred sources
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SOURCES.map((source) => (
                <label
                  key={source}
                  className="flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
                >
                  <input
                    type="checkbox"
                    name="preferredSources"
                    value={source}
                    className="cursor-pointer"
                  />
                  {source}
                </label>
              ))}
            </div>
          </fieldset>

          {error && <p className="text-center text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            className="cursor-pointer self-center rounded-full bg-black px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Save and continue
          </button>
        </form>
      </main>
    </div>
  );
}
