"use client";

import { useState } from "react";
import { TOPICS, type Topic } from "@/types";
import { MultiSelect } from "@/components/ui/multi-select";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";
import { MAX_READING_UNITS, MIN_READING_UNITS, countReadingUnits } from "@/lib/readingUnits";

const TOPICS_ID = "preferences-topics";
const COUNTER_ID = `${TOPICS_ID}-count`;

/**
 * The topics picker and, while Countries is picked, a countries picker right
 * below it. Both share one counter and one limit, in reading units: each
 * country counts as one, the Countries topic itself as nothing. They submit
 * as repeated `topics` / `countries` form fields.
 */
export function TopicPickers({
  defaultTopics = [],
  defaultCountries = [],
}: {
  defaultTopics?: Topic[];
  defaultCountries?: string[];
}) {
  const [topics, setTopics] = useState<Topic[]>(defaultTopics);
  // Countries saved without the Countries topic have nothing to show in.
  const [countries, setCountries] = useState<string[]>(() =>
    defaultTopics.includes(COUNTRIES_TOPIC) ? [...new Set(defaultCountries)] : []
  );
  const countriesPicked = topics.includes(COUNTRIES_TOPIC);

  function handleTopicsChange(next: Topic[]) {
    setTopics(next);
    // Unpicking Countries drops its countries, so picking it again starts
    // empty instead of bringing back picks the count no longer has room for.
    if (!next.includes(COUNTRIES_TOPIC)) setCountries([]);
  }

  return (
    <div className="flex flex-col gap-6">
      <MultiSelect
        id={TOPICS_ID}
        name="topics"
        label="Topics"
        hint={`Pick ${MIN_READING_UNITS} to ${MAX_READING_UNITS}. Type to search, or scroll the list.`}
        items={TOPICS}
        defaultValue={defaultTopics}
        max={MAX_READING_UNITS}
        noun={countriesPicked ? "topics and countries" : "topics"}
        placeholder="Search topics"
        countOf={(picked) => countReadingUnits(picked, countries)}
        onValueChange={handleTopicsChange}
      />

      {countriesPicked && (
        <MultiSelect
          id="preferences-countries"
          name="countries"
          label="Countries"
          hint={`Each country counts as one of your ${MAX_READING_UNITS}.`}
          items={COUNTRIES}
          defaultValue={countries}
          max={MAX_READING_UNITS}
          noun="countries"
          placeholder="Search countries"
          countOf={(picked) => countReadingUnits(topics, picked)}
          onValueChange={setCountries}
          counterId={COUNTER_ID}
        />
      )}
    </div>
  );
}
