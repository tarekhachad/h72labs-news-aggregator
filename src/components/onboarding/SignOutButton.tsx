"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { unstable_rethrow } from "next/navigation";
import { ConfirmDialog } from "@/components/newspaper/ConfirmDialog";
import { signOutAction } from "@/app/auth/actions";

/**
 * "Sign out" behind the same confirmation the newspaper menu (Sidebar.tsx)
 * shows: the shared ConfirmDialog with the same words, portaled to
 * document.body so its inert sweep can leave only itself live.
 */
export function SignOutButton({ className }: { className?: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, startSignOut] = useTransition();

  function handleConfirm() {
    setError(null);
    startSignOut(async () => {
      try {
        await signOutAction();
      } catch (e) {
        // A Server Action that redirects rejects on the client even when it
        // succeeded; unstable_rethrow passes Next's redirect through and
        // leaves only a real failure to show.
        unstable_rethrow(e);
        setError("Couldn't sign you out — check your connection and try again.");
      }
    });
  }

  return (
    <>
      <button type="button" onClick={() => setConfirming(true)} className={className}>
        Sign out
      </button>
      {confirming &&
        createPortal(
          <ConfirmDialog
            title="Sign out?"
            description="You'll need to sign in again to read your digest."
            confirmLabel="Sign out"
            destructive
            pending={signingOut}
            error={error}
            onConfirm={handleConfirm}
            onCancel={() => {
              // Ignored mid-flight: the sign-out is about to navigate away.
              if (signingOut) return;
              setError(null);
              setConfirming(false);
            }}
          />,
          document.body
        )}
    </>
  );
}
