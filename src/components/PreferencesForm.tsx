import { TOPICS, SOURCES, type Topic, type Source } from "@/types";
import { SubmitButton } from "@/components/SubmitButton";

export function PreferencesForm({
  action,
  defaultTopics = [],
  defaultSources = [],
  submitLabel,
  error,
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaultTopics?: Topic[];
  defaultSources?: Source[];
  submitLabel: string;
  error?: string;
}) {
  return (
    <form action={action} className="flex flex-col gap-8">
      <fieldset>
        <legend className="mb-3 text-sm font-medium text-black dark:text-zinc-50">Topics</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TOPICS.map((topic) => (
            <label
              key={topic}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200"
            >
              <input
                type="checkbox"
                name="topics"
                value={topic}
                defaultChecked={defaultTopics.includes(topic)}
                className="cursor-pointer"
              />
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
                defaultChecked={defaultSources.includes(source)}
                className="cursor-pointer"
              />
              {source}
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p className="text-center text-sm text-red-600">{error}</p>}

      <SubmitButton className="cursor-pointer self-center rounded-full bg-black px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-black dark:hover:bg-zinc-200">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
