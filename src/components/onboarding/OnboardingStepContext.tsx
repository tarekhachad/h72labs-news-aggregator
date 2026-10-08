"use client";

import { createContext, useContext, useState } from "react";

export const STEPS = [
  { letter: "A", name: "Topics" },
  { letter: "B", name: "Countries" },
  { letter: "C", name: "Outlets" },
  { letter: "D", name: "Review" },
] as const;

export const REVIEW_STEP = STEPS.length - 1;

type OnboardingStep = {
  /** The step shown, 0-based. */
  step: number;
  /** The furthest step reached so far: every step up to it can be jumped back to. */
  visited: number;
  goTo: (step: number) => void;
};

const OnboardingStepContext = createContext<OnboardingStep | null>(null);

/**
 * The onboarding step, shared by the page's header ("Step n of 4") and the
 * stepped form, which sit apart on the page.
 */
export function OnboardingStepProvider({ children }: { children: React.ReactNode }) {
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState(0);
  function goTo(next: number) {
    const clamped = Math.min(Math.max(next, 0), REVIEW_STEP);
    setStep(clamped);
    setVisited((furthest) => Math.max(furthest, clamped));
  }
  return (
    <OnboardingStepContext.Provider value={{ step, visited, goTo }}>{children}</OnboardingStepContext.Provider>
  );
}

export function useOnboardingStep(): OnboardingStep {
  const value = useContext(OnboardingStepContext);
  if (value === null) throw new Error("useOnboardingStep needs an OnboardingStepProvider above it");
  return value;
}
