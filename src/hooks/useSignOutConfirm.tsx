"use client";

import { useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { unstable_rethrow } from "next/navigation";
import { ConfirmDialog } from "@/components/newspaper/ConfirmDialog";
import { signOutAction } from "@/app/auth/actions";

/**
 * The "Sign out?" confirmation shared by the newspaper menu (Sidebar.tsx)
 * and onboarding's header (SignOutButton.tsx). `openSignOut` shows it;
 * `signOutDialog` is the dialog itself (null while closed), for the caller
 * to render anywhere in its tree. It portals to document.body, so where it
 * sits in the caller's JSX doesn't matter: useInertBackground sweeps body's
 * children and must be able to exclude only this dialog.
 */
export function useSignOutConfirm(): { openSignOut: () => void; signOutDialog: ReactNode } {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, startSignOut] = useTransition();

  function handleConfirm() {
    setError(null);
    // On success signOutAction redirects, so nothing after the await runs
    // — the transition just keeps both buttons disabled until that
    // navigation lands, rather than leaving a live "Sign out" under a
    // second click.
    //
    // supabase.auth.signOut() is a network call and can genuinely fail
    // (offline, expired session), so the failure path is handled rather
    // than left to bubble as an uncaught rejection: the dialog stays open
    // and shows the error so the user can retry or back out. Without the
    // catch, a failed sign-out crashed to the nearest error boundary.
    startSignOut(async () => {
      try {
        await signOutAction();
      } catch (e) {
        // This catch runs on SUCCESS too, not just failure: calling a
        // Server Action that redirects rejects the client-side promise
        // with a redirect-shaped error (Next's server-action reducer does
        // the navigation itself, then rejects). So unstable_rethrow isn't
        // defensive boilerplate here — it's what stops every successful
        // sign-out from falling through and showing a failure message.
        // It re-raises Next's own control-flow errors (which
        // RedirectErrorBoundary then absorbs, without re-navigating —
        // the navigation has already been dispatched) and no-ops for a
        // genuine error, which falls through to the message below.
        unstable_rethrow(e);
        setError("Couldn't sign you out — check your connection and try again.");
      }
    });
  }

  const signOutDialog = confirming
    ? createPortal(
        <ConfirmDialog
          title="Sign out?"
          description="You'll need to sign in again to read your digest."
          confirmLabel="Sign out"
          destructive
          pending={signingOut}
          error={error}
          onConfirm={handleConfirm}
          onCancel={() => {
            // Ignored mid-flight: signOutAction is already running and
            // about to navigate, so dismissing here would flash the page
            // back to an interactive state it's leaving anyway. Applies
            // to all three dismiss paths, since they share this handler.
            if (signingOut) return;
            setError(null);
            setConfirming(false);
          }}
        />,
        document.body
      )
    : null;

  return { openSignOut: () => setConfirming(true), signOutDialog };
}
