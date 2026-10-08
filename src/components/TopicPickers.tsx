"use client";

import { useState } from "react";
import { TOPICS, type Topic } from "@/types";
import { MultiSelect } from "@/components/ui/multi-select";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";
import { MAX_READING_UNITS, MIN_READING_UNITS, countReadingUnits } from "@/lib/readingUnits";

const TOPICS_ID = "preferences-topics";
const COUNTER_ID = `${TOPICS_ID}-count`;

// Countries isn't offered as a topic: the server saves it exactly when a
// country is picked (ProfileInput in src/lib/profile.ts).
const PICKABLE_TOPICS = TOPICS.filter((topic) => topic !== COUNTRIES_TOPIC);

// Counts as the server will save it, with the Countries topic added when
// there are countries, so countReadingUnits stays the one counting rule.
function unitsOf(topics: readonly Topic[], countries: readonly string[]): number {
  return countReadingUnits(countries.length > 0 ? [...topics, COUNTRIES_TOPIC] : topics, countries);
}

/**
 * The topics picker and, always below it, the optional countries picker.
 * Both share one counter and one limit, in reading units: each topic and each
 * country counts as one. They submit as repeated `topics` / `countries` form
 * fields; picking a country is what turns the Countries page on.
 */
export function TopicPickers({
  defaultTopics = [],
  defaultCountries = [],
}: {
  defaultTopics?: Topic[];
  defaultCountries?: string[];
}) {
  // A saved profile with countries also has the Countries topic, which has no
  // chip to show in: its countries stand for it.
  const savedTopics = defaultTopics.filter((topic) => topic !== COUNTRIES_TOPIC);
  const [topics, setTopics] = useState<Topic[]>(savedTopics);
  const [countries, setCountries] = useState<string[]>(() => [...new Set(defaultCountries)]);

  return (
    <div className="flex flex-col gap-6">
      <MultiSelect
        id={TOPICS_ID}
        name="topics"
        label="Topics"
        hint={`Pick ${MIN_READING_UNITS} to ${MAX_READING_UNITS}. Type to search, or scroll the list.`}
        items={PICKABLE_TOPICS}
        defaultValue={savedTopics}
        max={MAX_READING_UNITS}
        noun={countries.length > 0 ? "topics and countries" : "topics"}
        placeholder="Search topics"
        countOf={(picked) => unitsOf(picked, countries)}
        onValueChange={setTopics}
      />

      <MultiSelect
        id="preferences-countries"
        name="countries"
        label="Countries (optional)"
        hint={`Each country counts as one of your ${MAX_READING_UNITS}.`}
        items={COUNTRIES}
        defaultValue={countries}
        max={MAX_READING_UNITS}
        noun="countries"
        placeholder="Search countries"
        countOf={(picked) => unitsOf(topics, picked)}
        onValueChange={setCountries}
        counterId={COUNTER_ID}
      />
    </div>
  );
}
