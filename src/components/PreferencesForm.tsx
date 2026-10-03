import { TOPICS, SOURCES, type Topic, type Source } from "@/types";
import { MAX_TOPICS, MIN_TOPICS } from "@/lib/profile";
import { SubmitButton } from "@/components/SubmitButton";
import { MultiSelect } from "@/components/ui/multi-select";

// The two pickers submit as repeated `topics` / `preferredSources` form
// fields, the names the onboarding and profile actions read with getAll().
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
      <MultiSelect
        id="preferences-topics"
        name="topics"
        label="Topics"
        hint={`Pick ${MIN_TOPICS} to ${MAX_TOPICS}. Type to search, or scroll the list.`}
        items={TOPICS}
        defaultValue={defaultTopics}
        max={MAX_TOPICS}
        noun="topics"
        placeholder="Search topics"
      />

      <MultiSelect
        id="preferences-sources"
        name="preferredSources"
        label="Preferred sources"
        hint="Optional. Pick none to read every source for your topics."
        items={SOURCES}
        defaultValue={defaultSources}
        noun="sources"
        placeholder="Search sources"
      />

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
