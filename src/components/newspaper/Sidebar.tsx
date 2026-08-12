"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Menu, Bookmark, History, Settings, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/newspaper/ConfirmDialog";
import { signOutAction } from "@/app/auth/actions";

/**
 * Hamburger-triggered overlay sidebar, present on every newspaper page (see
 * docs/(C) UI_DESIGN.md's Sidebar section). shadcn's Sheet already gives us
 * the overlay/dimmed-backdrop/focus-trap behavior for free — the underlying
 * page never resizes, so grid box-sizing never has to account for a
 * variable content width.
 */
export function Sidebar() {
  // The Sheet is controlled solely so signing out can close it before the
  // confirmation appears. Everything else in here still closes it the
  // declarative way, via SheetClose.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, startSignOut] = useTransition();

  function handleConfirmSignOut() {
    setSignOutError(null);
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
        setSignOutError("Couldn't sign you out — check your connection and try again.");
      }
    });
  }

  return (
    <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Open menu" className="cursor-pointer">
            <Menu />
          </Button>
        }
      />
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle className="font-heading">Menu</SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-1 px-4">
          {/* SheetClose, not a plain Link: Masthead/Sidebar live in the
              shared (paper) layout and stay mounted across client-side
              navigation within it, so a plain Link click would change the
              URL but leave the Sheet's open state (and its inert-behind-
              backdrop underlying page) untouched — the destination page,
              including its own hamburger, would be stuck non-interactable
              until manually dismissed. SheetClose's render prop closes the
              dialog synchronously with the navigation, same pattern as the
              visible X button below. nativeButton={false} suppresses Base
              UI's dev warning about rendering a non-native-button element
              (it defaults to expecting one), but as a side effect Base UI
              applies role="button" to these anchors regardless of the
              underlying <a> tag — assistive tech announces them as
              buttons, not links, even though they're real navigable hrefs.
              Accepted trade-off for the close-and-navigate pattern. */}
          <SheetClose
            nativeButton={false}
            render={
              <Link
                href="/saved"
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-[var(--color-muted)]"
              />
            }
          >
            <Bookmark className="size-4" /> Saved
          </SheetClose>
          <SheetClose
            nativeButton={false}
            render={
              <Link
                href="/history"
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-[var(--color-muted)]"
              />
            }
          >
            <History className="size-4" /> History
          </SheetClose>
          <SheetClose
            nativeButton={false}
            render={
              <Link
                href="/profile"
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-[var(--color-muted)]"
              />
            }
          >
            <Settings className="size-4" /> Settings
          </SheetClose>
          {/* Not a SheetClose, and no longer a form that submits straight
              to signOutAction (Phase 8.2): this closes the sheet AND opens
              the confirmation, and the confirmation is what invokes the
              action. Closing the sheet first is structural, not cosmetic —
              the sheet is a Base UI Dialog that installs its own focus
              trap and hides the rest of the page with aria-hidden (not the
              DOM `inert` property useInertBackground uses; verified in
              Base UI's DialogPopup/FloatingFocusManager source). Since
              ConfirmDialog portals to document.body as a sibling of it,
              leaving the sheet open would put two competing focus managers
              on screen at once. */}
          <button
            type="button"
            onClick={() => {
              setSheetOpen(false);
              setConfirmingSignOut(true);
            }}
            className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-[var(--color-muted)]"
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </nav>
      </SheetContent>

      {/* Portaled to document.body rather than rendered here, so it isn't a
          descendant of the Sheet's own subtree — useInertBackground sweeps
          body's children and must be able to exclude only this dialog. */}
      {confirmingSignOut &&
        createPortal(
          <ConfirmDialog
            title="Sign out?"
            description="You'll need to sign in again to read your digest."
            confirmLabel="Sign out"
            destructive
            pending={signingOut}
            error={signOutError}
            onConfirm={handleConfirmSignOut}
            onCancel={() => {
              // Ignored mid-flight: signOutAction is already running and
              // about to navigate, so dismissing here would flash the page
              // back to an interactive state it's leaving anyway. Applies
              // to all three dismiss paths, since they share this handler.
              if (signingOut) return;
              setSignOutError(null);
              setConfirmingSignOut(false);
            }}
          />,
          document.body
        )}
    </Sheet>
  );
}
