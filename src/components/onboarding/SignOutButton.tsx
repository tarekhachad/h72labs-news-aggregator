"use client";

import { useSignOutConfirm } from "@/hooks/useSignOutConfirm";

/**
 * "Sign out" behind the same confirmation the newspaper menu (Sidebar.tsx)
 * shows, through the hook both share.
 */
export function SignOutButton({ className }: { className?: string }) {
  const { openSignOut, signOutDialog } = useSignOutConfirm();

  return (
    <>
      <button type="button" onClick={openSignOut} className={className}>
        Sign out
      </button>
      {signOutDialog}
    </>
  );
}
