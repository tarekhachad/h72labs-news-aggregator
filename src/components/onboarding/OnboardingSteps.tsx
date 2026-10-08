"use client";

import { useEffect, useRef, useState } from "react";
import type { Source, Topic } from "@/types";
import { MIN_READING_UNITS } from "@/lib/readingUnits";
import { REVIEW_STEP, STEPS, useOnboardingStep } from "@/components/onboarding/OnboardingStepContext";
import { ReviewStep } from "@/components/onboarding/ReviewStep";
import { SaveButton } from "@/components/onboarding/SaveButton";
import { belowMinimumReason, unitsOf } from "@/components/onboarding/picks";

const STEP_BUTTON =
  "cursor-pointer rounded-full border border-[var(--color-foreground)] px-5 py-2 text-sm font-medium outline-none hover:bg-[var(--color-foreground)] hover:text-[var(--color-background)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2";

/**
 * Onboarding as four steps inside the one <form>: Topics, Countries,
 * Outlets, Review. A step is only shown or hidden, never unmounted, so every
 * picker's hidden inputs submit from any step and the save action reads the
 * same fields as the single-page form. Steps switch at once, with no fade,
 * and focus moves to the new step's heading.
 *
 * The form saves only from Review: Enter in any text field never submits
 * (nor moves the steps on), and a submit from another step is dropped.
 */
export function OnboardingSteps({
  action,
  topics,
  countries,
  sources,
  topicsStep,
  countriesStep,
  outletsStep,
  error,
  submitLabel,
}: {
  action: (formData: FormData) => void;
  topics: readonly Topic[];
  countries: readonly string[];
  sources: readonly Source[];
  topicsStep: React.ReactNode;
  countriesStep: React.ReactNode;
  outletsStep: React.ReactNode;
  /** The refused save's message, shown on Review. */
  error: string | null;
  submitLabel: string;
}) {
  const { step, visited, goTo } = useOnboardingStep();
  const headings = useRef<(HTMLHeadingElement | null)[]>([]);
  const focusHeading = useRef(false);
  const [triedNext, setTriedNext] = useState(false);

  const units = unitsOf(topics, countries);
  const belowMin = units < MIN_READING_UNITS;

  // Only after a move the reader made: on first load focus stays put.
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    headings.current[step]?.focus();
  }, [step]);

  function move(to: number) {
    focusHeading.current = true;
    goTo(to);
  }

  function nextFromTopics() {
    if (belowMin) {
      setTriedNext(true);
      return;
    }
    setTriedNext(false);
    move(1);
  }

  function holdEnter(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  }

  function heading(index: number, title: string) {
    return (
      <h2
        ref={(el) => {
          headings.current[index] = el;
        }}
        tabIndex={-1}
        className="font-heading text-xl font-semibold outline-none"
      >
        {title}
      </h2>
    );
  }

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (step !== REVIEW_STEP || belowMin) event.preventDefault();
      }}
      onKeyDown={holdEnter}
      className="flex flex-col gap-8"
    >
      <StepIndex step={step} visited={visited} onJump={move} />

      <section hidden={step !== 0} aria-label={STEPS[0].name} className="flex flex-col gap-6">
        {heading(0, "Pick your topics")}
        {topicsStep}
        <div className="flex flex-col items-end gap-2">
          {triedNext && belowMin && (
            <p role="alert" className="text-sm" style={{ color: "var(--color-destructive)" }}>
              {belowMinimumReason(units, MIN_READING_UNITS, "continue")}
            </p>
          )}
          <button type="button" onClick={nextFromTopics} className={STEP_BUTTON}>
            Next: Countries
          </button>
        </div>
      </section>

      <section hidden={step !== 1} aria-label={STEPS[1].name} className="flex max-w-2xl flex-col gap-6">
        {heading(1, "Add countries (optional)")}
        <p className="text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          A country gets its own section, read from that country&apos;s own outlets. Skip this to read only your topics.
        </p>
        {countriesStep}
        <StepButtons
          onBack={() => move(0)}
          onNext={() => move(2)}
          nextLabel={countries.length > 0 ? "Next: Outlets" : "Skip"}
        />
      </section>

      <section hidden={step !== 2} aria-label={STEPS[2].name} className="flex max-w-2xl flex-col gap-6">
        {heading(2, "Prefer outlets (optional)")}
        <p className="text-sm" style={{ color: "var(--color-muted-foreground)" }}>
          Outlets you pick lead a story when they cover it. Skip this to read every outlet for your topics.
        </p>
        {outletsStep}
        <StepButtons
          onBack={() => move(1)}
          onNext={() => move(REVIEW_STEP)}
          nextLabel={sources.length > 0 ? "Next: Review" : "Skip"}
        />
      </section>

      <section hidden={step !== REVIEW_STEP} aria-label={STEPS[REVIEW_STEP].name} className="flex max-w-2xl flex-col gap-6">
        {heading(REVIEW_STEP, "Your edition will read…")}
        <ReviewStep topics={topics} countries={countries} sources={sources} onEdit={move} />
        {error !== null && (
          <p role="alert" className="text-center text-sm" style={{ color: "var(--color-destructive)" }}>
            {error}
          </p>
        )}
        <div className="flex items-start justify-between gap-4">
          <button type="button" onClick={() => move(2)} className={STEP_BUTTON}>
            Back
          </button>
          <SaveButton blockedReason={belowMin ? belowMinimumReason(units, MIN_READING_UNITS, "save") : null}>
            {submitLabel}
          </SaveButton>
        </div>
      </section>
    </form>
  );
}

function StepButtons({ onBack, onNext, nextLabel }: { onBack: () => void; onNext: () => void; nextLabel: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <button type="button" onClick={onBack} className={STEP_BUTTON}>
        Back
      </button>
      <button type="button" onClick={onNext} className={STEP_BUTTON}>
        {nextLabel}
      </button>
    </div>
  );
}

/**
 * The steps as a newspaper section index, "A · Topics — B · Countries — …",
 * over a 1 px rule. The current step is in ink; a step already reached is a
 * button back to it; a step not reached yet is plain text.
 */
function StepIndex({ step, visited, onJump }: { step: number; visited: number; onJump: (step: number) => void }) {
  return (
    <nav aria-label="Setup steps" className="border-b pb-2" style={{ borderColor: "var(--color-rule)" }}>
      <ol className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-heading text-[15px]">
        {STEPS.map((s, index) => {
          const label = `${s.letter} · ${s.name}`;
          return (
            <li key={s.name} className="flex items-baseline gap-2">
              {index > 0 && (
                <span aria-hidden="true" style={{ color: "var(--color-muted-foreground)" }}>
                  —
                </span>
              )}
              {index === step ? (
                <span aria-current="step" className="font-semibold" style={{ color: "var(--color-foreground)" }}>
                  {label}
                </span>
              ) : index <= visited ? (
                <button
                  type="button"
                  onClick={() => onJump(index)}
                  className="cursor-pointer rounded-[2px] underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                  style={{ color: "var(--color-muted-foreground)" }}
                >
                  {label}
                </button>
              ) : (
                <span style={{ color: "var(--color-muted-foreground)", opacity: 0.6 }}>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
