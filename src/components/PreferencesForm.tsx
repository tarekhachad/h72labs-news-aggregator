"use client";

import { createContext, useActionState, useContext, useMemo, useState } from "react";
import { SOURCES, type Topic, type Source } from "@/types";
import { MultiSelect } from "@/components/ui/multi-select";
import { coverageDetail, coveredPicks, groupSourcesByCoverage, type SourceCoverage } from "@/lib/sourceCoverage";
import { CountriesPicker, TopicPickers, TopicsPicker } from "@/components/TopicPickers";
import { OnboardingSteps } from "@/components/onboarding/OnboardingSteps";
import { SaveButton } from "@/components/onboarding/SaveButton";
import { belowMinimumReason, unitsOf } from "@/components/onboarding/picks";
import { COUNTRIES_TOPIC } from "@/config/countries";
import { MIN_READING_UNITS } from "@/lib/readingUnits";
import { PROFILE_ERROR_MESSAGES, isProfileErrorCode, type PreferencesState } from "@/lib/profileErrors";

const NO_ERROR: PreferencesState = { error: null };

const SourceCoverageContext = createContext<SourceCoverage | null>(null);

/**
 * Hands the preferences form below it the outlet coverage map, for a page
 * that renders the form inside another component (OnboardingView) rather
 * than directly; a page that renders it directly passes `sourceCoverage`.
 */
export function SourceCoverageProvider({
  coverage,
  children,
}: {
  coverage: SourceCoverage;
  children: React.ReactNode;
}) {
  return <SourceCoverageContext value={coverage}>{children}</SourceCoverageContext>;
}

/** "Kicker publishes nothing in your topics yet…": a picked outlet that covers none of the reader's picks. */
function noCoverageNote(source: Source, withCountries: boolean): string {
  const picks = withCountries ? "your topics or countries" : "your topics";
  return `${source} publishes nothing in ${picks} yet, so it won't change your edition.`;
}

// The pickers submit as repeated `topics` / `countries` / `preferredSources`
// form fields, the names the onboarding and profile actions read with getAll().
//
// A refused save comes back as a state rather than a navigation, so nothing
// remounts: the picks stay in this component's state, and React's reset of
// the form after the action leaves their hidden inputs alone (a hidden
// input's value is its attribute, which a reset doesn't change).
export function PreferencesForm({
  action,
  defaultTopics = [],
  defaultCountries = [],
  defaultSources = [],
  submitLabel,
  savedMessage,
  stepped = false,
  sourceCoverage,
}: {
  /** Returns the refusal, or redirects on success. One that returns nothing (the dev fixture page's) counts as no error. */
  action: (previous: PreferencesState | void, formData: FormData) => Promise<PreferencesState | void>;
  defaultTopics?: Topic[];
  defaultCountries?: string[];
  defaultSources?: Source[];
  submitLabel: string;
  /** Shown under the form after a successful save, until a later save is refused. */
  savedMessage?: string;
  /** Onboarding's four steps (needs an OnboardingStepProvider above it) instead of one page. */
  stepped?: boolean;
  /**
   * Which topics and countries each outlet publishes in, built on the server
   * (buildSourceCoverage) so no feed URL reaches the browser. Falls back to a
   * SourceCoverageProvider above; with neither, the outlets picker is a plain
   * list and the review step names the picks without their coverage.
   */
  sourceCoverage?: SourceCoverage;
}) {
  const [state, formAction, pending] = useActionState<PreferencesState | void, FormData>(action, NO_ERROR);
  // Hidden while a save is pending, so the same refusal twice is inserted
  // again and screen readers announce it again.
  const error = !pending && isProfileErrorCode(state?.error) ? state.error : null;

  // A saved profile with countries also has the Countries topic, which has no
  // chip to show in: its countries stand for it.
  const [topics, setTopics] = useState<Topic[]>(() => defaultTopics.filter((topic) => topic !== COUNTRIES_TOPIC));
  const [countries, setCountries] = useState<string[]>(() => [...new Set(defaultCountries)]);
  const [sources, setSources] = useState<Source[]>(() => [...defaultSources]);

  const units = unitsOf(topics, countries);

  // The outlets regroup as the reader picks: those covering their topics,
  // then their countries, then the rest by country.
  const providedCoverage = useContext(SourceCoverageContext);
  const coverage = sourceCoverage ?? providedCoverage;
  const sourceGroups = useMemo(
    () => (coverage ? groupSourcesByCoverage(coverage, topics, countries) : null),
    [coverage, topics, countries]
  );
  const uncovered = coverage
    ? sources.filter((source) => {
        const covered = coveredPicks(coverage, source, topics, countries);
        return covered.topics.length === 0 && covered.countries.length === 0;
      })
    : [];

  const sourcesPicker = (
    <div className="flex flex-col gap-2">
      <MultiSelect
        id="preferences-sources"
        name="preferredSources"
        label="Preferred sources"
        hint="Optional. Pick none to read every source for your topics."
        items={sourceGroups ?? SOURCES}
        defaultValue={defaultSources}
        noun="sources"
        placeholder="Search sources"
        onValueChange={setSources}
        itemDetail={coverage ? (source) => coverageDetail(coverage, source, topics, countries) : undefined}
      />
      {/* Always mounted: a live region only announces changes to one already in the DOM. */}
      <div aria-live="polite" data-testid="outlet-coverage-notes" className="flex flex-col gap-1">
        {uncovered.map((source) => (
          <p key={source} className="text-sm" style={{ color: "var(--color-muted-foreground)" }}>
            {noCoverageNote(source, countries.length > 0)}
          </p>
        ))}
      </div>
    </div>
  );

  if (stepped) {
    return (
      <OnboardingSteps
        action={formAction}
        topics={topics}
        countries={countries}
        sources={sources}
        coverage={coverage}
        topicsStep={<TopicsPicker topics={topics} countries={countries} onTopicsChange={setTopics} onboarding />}
        countriesStep={
          <CountriesPicker
            topics={topics}
            countries={countries}
            onCountriesChange={setCountries}
            sharedCounter={false}
          />
        }
        outletsStep={sourcesPicker}
        error={error && PROFILE_ERROR_MESSAGES[error]}
        submitLabel={submitLabel}
      />
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-8">
      <TopicPickers
        topics={topics}
        countries={countries}
        onTopicsChange={setTopics}
        onCountriesChange={setCountries}
      />

      {sourcesPicker}

      {error && (
        <p role="alert" className="text-center text-sm" style={{ color: "var(--color-destructive)" }}>
          {PROFILE_ERROR_MESSAGES[error]}
        </p>
      )}

      <SaveButton
        blockedReason={units < MIN_READING_UNITS ? belowMinimumReason(units, MIN_READING_UNITS, "save") : null}
      >
        {submitLabel}
      </SaveButton>

      {savedMessage && !pending && !state?.error && (
        <p role="status" className="text-center text-sm" style={{ color: "var(--color-foreground)" }}>
          {savedMessage}
        </p>
      )}
    </form>
  );
}
