"use client";

import { useActionState } from "react";
import { SOURCES, type Topic, type Source } from "@/types";
import { SubmitButton } from "@/components/SubmitButton";
import { MultiSelect } from "@/components/ui/multi-select";
import { TopicPickers } from "@/components/TopicPickers";
import { PROFILE_ERROR_MESSAGES, isProfileErrorCode, type PreferencesState } from "@/lib/profileErrors";

const NO_ERROR: PreferencesState = { error: null };

// The pickers submit as repeated `topics` / `countries` / `preferredSources`
// form fields, the names the onboarding and profile actions read with getAll().
//
// A refused save comes back as a state rather than a navigation, so nothing
// remounts: the picks stay in the pickers' state, and React's reset of the
// form after the action leaves their hidden inputs alone (a hidden input's
// value is its attribute, which a reset doesn't change).
export function PreferencesForm({
  action,
  defaultTopics = [],
  defaultCountries = [],
  defaultSources = [],
  submitLabel,
  savedMessage,
}: {
  /** Returns the refusal, or redirects on success. One that returns nothing (the dev fixture page's) counts as no error. */
  action: (previous: PreferencesState | void, formData: FormData) => Promise<PreferencesState | void>;
  defaultTopics?: Topic[];
  defaultCountries?: string[];
  defaultSources?: Source[];
  submitLabel: string;
  /** Shown under the form after a successful save, until a later save is refused. */
  savedMessage?: string;
}) {
  const [state, formAction, pending] = useActionState<PreferencesState | void, FormData>(action, NO_ERROR);
  // Hidden while a save is pending, so the same refusal twice is inserted
  // again and screen readers announce it again.
  const error = !pending && isProfileErrorCode(state?.error) ? state.error : null;

  return (
    <form action={formAction} className="flex flex-col gap-8">
      <TopicPickers defaultTopics={defaultTopics} defaultCountries={defaultCountries} />

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
        <p role="alert" className="text-center text-sm" style={{ color: "var(--color-destructive)" }}>
          {PROFILE_ERROR_MESSAGES[error]}
        </p>
      )}

      <SubmitButton
        className="cursor-pointer self-center rounded-full px-8 py-3 text-sm font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ background: "var(--color-primary)", color: "var(--color-on-primary)" }}
      >
        {submitLabel}
      </SubmitButton>

      {savedMessage && !pending && !state?.error && (
        <p role="status" className="text-center text-sm" style={{ color: "var(--color-foreground)" }}>
          {savedMessage}
        </p>
      )}
    </form>
  );
}
