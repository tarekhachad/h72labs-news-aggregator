"use client";

import { PRODUCT_NAME } from "@/config/brand";
import { STEPS, useOnboardingStep } from "@/components/onboarding/OnboardingStepContext";
import { SignOutButton } from "@/components/onboarding/SignOutButton";

/**
 * Onboarding's slim header: /onboarding sits outside the (paper) layout, so
 * it has no masthead of its own. The product name, where the reader is, and
 * a way out.
 */
export function OnboardingHeader() {
  const { step } = useOnboardingStep();
  return (
    <header
      className="flex items-center justify-between gap-4 border-b px-6 py-3 md:px-10"
      style={{ borderColor: "var(--color-rule)", background: "var(--color-background)" }}
    >
      <span className="font-heading text-xl font-bold tracking-tight">{PRODUCT_NAME}</span>
      <div className="flex items-center gap-5 text-sm">
        <span className="tabular-nums" style={{ color: "var(--color-muted-foreground)" }}>
          {`Step ${step + 1} of ${STEPS.length}`}
        </span>
        <SignOutButton className="cursor-pointer rounded-[2px] px-2 py-1 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]" />
      </div>
    </header>
  );
}
