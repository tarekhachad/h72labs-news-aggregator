"use client";

import type { Topic } from "@/types";
import { MultiSelect } from "@/components/ui/multi-select";
import { TopicGrid } from "@/components/onboarding/TopicGrid";
import { unitsOf } from "@/components/onboarding/picks";
import { COUNTRIES } from "@/config/countries";
import { countryCode, type CountryCode } from "@/config/countryCodes";
import { MAX_READING_UNITS, MIN_READING_UNITS } from "@/lib/readingUnits";
// One named import per flag, so the bundle carries these 99 and not the
// package's other ~160.
import {
  AF, AR, AT, AU, BD, BF, BG, BR, BW, CA, CD, CH, CI, CL, CM, CN, CR, CU, CY, CZ, DE, DK, DO,
  DZ, EG, ES, ET, FI, FR, GB, GH, GM, GR, GT, HK, HR, HU, ID, IE, IL, IN, IQ, IR, IS, IT, JO,
  JP, KE, KH, KP, KR, KZ, LB, LV, LY, MA, ML, MM, MT, MX, MY, MZ, NA, NG, NI, NO, NP, NZ, PA,
  PE, PH, PK, PL, PR, PS, PT, RO, RS, RU, RW, SD, SE, SG, SK, SN, SY, TH, TN, TR, TZ, UA, UG,
  US, UY, UZ, VE, ZA, ZM, ZW,
  type FlagComponent,
} from "country-flag-icons/react/3x2";

export const TOPICS_ID = "preferences-topics";
/** The shared counter's id: the topic grid shows it, and the countries picker is described by it. */
export const COUNTER_ID = `${TOPICS_ID}-count`;

// Typed over every code, so a country added to COUNTRY_CODES without its
// flag here fails the typecheck.
const FLAGS: Record<CountryCode, FlagComponent> = {
  AF, AR, AT, AU, BD, BF, BG, BR, BW, CA, CD, CH, CI, CL, CM, CN, CR, CU, CY, CZ, DE, DK, DO,
  DZ, EG, ES, ET, FI, FR, GB, GH, GM, GR, GT, HK, HR, HU, ID, IE, IL, IN, IQ, IR, IS, IT, JO,
  JP, KE, KH, KP, KR, KZ, LB, LV, LY, MA, ML, MM, MT, MX, MY, MZ, NA, NG, NI, NO, NP, NZ, PA,
  PE, PH, PK, PL, PR, PS, PT, RO, RS, RU, RW, SD, SE, SG, SK, SN, SY, TH, TN, TR, TZ, UA, UG,
  US, UY, UZ, VE, ZA, ZM, ZW,
};

// An SVG rather than an emoji flag: Windows draws emoji flags as two letters.
// Decorative, so screen readers read only the name beside it. The ring keeps
// white-edged flags (Japan, Cyprus) visible on a white list.
function countryFlag(country: string) {
  const code = countryCode(country);
  if (code === null) return null;
  const Flag = FLAGS[code];
  return (
    <Flag
      aria-hidden="true"
      focusable="false"
      data-slot="country-flag"
      className="h-3 w-[18px] shrink-0 rounded-[2px]"
      style={{ boxShadow: "0 0 0 1px var(--color-border)" }}
    />
  );
}

/** The noun the counters and notices use: countries count once any is picked. */
function unitNoun(countries: readonly string[]): string {
  return countries.length > 0 ? "topics and countries" : "topics";
}

/**
 * The topic grid, counting the picked countries against the shared limit.
 * `onboarding` adds the starter sets and pins the counter while the grid
 * scrolls; /profile has neither (its masthead holds the top of the screen).
 */
export function TopicsPicker({
  topics,
  countries,
  onTopicsChange,
  onboarding = false,
}: {
  topics: readonly Topic[];
  countries: readonly string[];
  onTopicsChange: (next: Topic[]) => void;
  onboarding?: boolean;
}) {
  return (
    <TopicGrid
      id={TOPICS_ID}
      name="topics"
      value={topics}
      onChange={onTopicsChange}
      countOf={(picked) => unitsOf(picked, countries)}
      min={MIN_READING_UNITS}
      max={MAX_READING_UNITS}
      noun={unitNoun(countries)}
      countryCount={countries.length}
      starterSets={onboarding}
      stickyCounter={onboarding}
    />
  );
}

/**
 * The optional countries picker. Its picks count against the topics' limit.
 * With `sharedCounter` it is described by the topic grid's counter instead of
 * showing its own; without it (a step of its own, the grid out of view), it
 * shows the same shared count itself.
 */
export function CountriesPicker({
  topics,
  countries,
  onCountriesChange,
  sharedCounter,
}: {
  topics: readonly Topic[];
  countries: readonly string[];
  onCountriesChange: (next: string[]) => void;
  sharedCounter: boolean;
}) {
  return (
    <MultiSelect
      id="preferences-countries"
      name="countries"
      label="Countries (optional)"
      hint={`Each country counts as one of your ${MAX_READING_UNITS}.`}
      items={COUNTRIES}
      defaultValue={countries}
      max={MAX_READING_UNITS}
      noun={unitNoun(countries)}
      placeholder="Search countries"
      countOf={(picked) => unitsOf(topics, picked)}
      onValueChange={onCountriesChange}
      counterId={sharedCounter ? COUNTER_ID : undefined}
      itemIcon={countryFlag}
    />
  );
}

/**
 * The topic grid and, always below it, the optional countries picker, as the
 * single-page preferences form shows them. Both share one counter and one
 * limit, in reading units: each topic and each country counts as one. They
 * submit as repeated `topics` / `countries` form fields; picking a country is
 * what turns the Countries page on. The picks are the parent's state.
 */
export function TopicPickers({
  topics,
  countries,
  onTopicsChange,
  onCountriesChange,
}: {
  topics: readonly Topic[];
  countries: readonly string[];
  onTopicsChange: (next: Topic[]) => void;
  onCountriesChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <TopicsPicker topics={topics} countries={countries} onTopicsChange={onTopicsChange} />
      <CountriesPicker
        topics={topics}
        countries={countries}
        onCountriesChange={onCountriesChange}
        sharedCounter
      />
    </div>
  );
}
