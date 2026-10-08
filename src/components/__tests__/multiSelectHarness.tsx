import { SOURCES, type Source, type Topic } from "@/types";
import { MultiSelect } from "@/components/ui/multi-select";
import { PICKABLE_TOPICS } from "@/components/onboarding/picks";
import { MAX_READING_UNITS, MIN_READING_UNITS } from "@/lib/readingUnits";

/**
 * MultiSelect's own rules (Escape never clears, Enter only adds, the limit,
 * the trim notice, chip keyboard) as a plain form: a limited picker over the
 * topic names, under the ids the topics dropdown had, plus the sources
 * picker. The topics are a grid now, but the countries and sources pickers
 * still run on this component, so its rules are tested on their own here.
 */
export function MultiSelectForm({
  topics = [],
  sources = [],
  onSubmit,
}: {
  topics?: Topic[];
  sources?: Source[];
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(event);
      }}
      className="flex flex-col gap-8"
    >
      <MultiSelect
        id="preferences-topics"
        name="topics"
        label="Topics"
        hint={`Pick ${MIN_READING_UNITS} to ${MAX_READING_UNITS}. Type to search, or scroll the list.`}
        items={PICKABLE_TOPICS}
        defaultValue={topics}
        min={MIN_READING_UNITS}
        max={MAX_READING_UNITS}
        noun="topics"
        placeholder="Search topics"
      />
      <MultiSelect
        id="preferences-sources"
        name="preferredSources"
        label="Preferred sources"
        hint="Optional. Pick none to read every source for your topics."
        items={SOURCES}
        defaultValue={sources}
        noun="sources"
        placeholder="Search sources"
      />
      <button type="submit">Save</button>
    </form>
  );
}
