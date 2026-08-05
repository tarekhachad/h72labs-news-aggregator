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
        <legend className="mb-3 text-sm font-medium">Topics</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TOPICS.map((topic) => (
            <label
              key={topic}
              // Colors are Tailwind arbitrary-value classes here, not the
              // inline `style` this codebase otherwise defaults to for
              // design-token colors — an inline style would always win
              // over the has-[:checked]: class below regardless of
              // specificity, silently defeating the checked-state toggle.
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm text-[var(--color-card-foreground)] transition-colors duration-150 has-[:checked]:border-[var(--color-primary)] has-[:checked]:bg-[var(--color-primary)] has-[:checked]:text-[var(--color-on-primary)]"
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
        <legend className="mb-3 text-sm font-medium">Preferred sources</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SOURCES.map((source) => (
            <label
              key={source}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm text-[var(--color-card-foreground)] transition-colors duration-150 has-[:checked]:border-[var(--color-primary)] has-[:checked]:bg-[var(--color-primary)] has-[:checked]:text-[var(--color-on-primary)]"
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

      {error && (
        <p className="text-center text-sm" style={{ color: "var(--color-destructive)" }}>
          {error}
        </p>
      )}

      <SubmitButton
        className="cursor-pointer self-center rounded-full px-8 py-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: "var(--color-primary)", color: "var(--color-on-primary)" }}
      >
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
