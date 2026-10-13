"use client";

import { Suspense, use, useState } from "react";
import Link from "next/link";
import { Menu, Bookmark, History, Settings, LogOut, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useSignOutConfirm } from "@/hooks/useSignOutConfirm";

/**
 * Hamburger-triggered overlay sidebar, present on every newspaper page (see
 * docs/(C) UI_DESIGN.md's Sidebar section). shadcn's Sheet already gives us
 * the overlay/dimmed-backdrop/focus-trap behavior for free — the underlying
 * page never resizes, so grid box-sizing never has to account for a
 * variable content width.
 */
/**
 * `pendingRequests` resolves to a count for an admin and null for everyone
 * else (see pending_invite_request_count), so only an admin sees the link.
 */
export function Sidebar({ pendingRequests }: { pendingRequests?: Promise<number | null> }) {
  // The Sheet is controlled solely so signing out can close it before the
  // confirmation appears. Everything else in here still closes it the
  // declarative way, via SheetClose.
  const [sheetOpen, setSheetOpen] = useState(false);
  const { openSignOut, signOutDialog } = useSignOutConfirm();

  return (
    <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Open menu" className="relative cursor-pointer">
            <Menu />
            {pendingRequests && (
              <Suspense fallback={null}>
                <PendingDot count={pendingRequests} />
              </Suspense>
            )}
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
          {pendingRequests && (
            <Suspense fallback={null}>
              <AdminLink count={pendingRequests} />
            </Suspense>
          )}
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
              openSignOut();
            }}
            className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-[var(--color-muted)]"
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </nav>
      </SheetContent>

      {/* The hook portals this to document.body, so it isn't a descendant
          of the Sheet's own subtree — useInertBackground sweeps body's
          children and must be able to exclude only this dialog. */}
      {signOutDialog}
    </Sheet>
  );
}

function AdminLink({ count }: { count: Promise<number | null> }) {
  const pending = use(count);
  if (pending === null) return null;
  return (
    <SheetClose
      nativeButton={false}
      render={
        <Link
          href="/admin/requests"
          className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-[var(--color-muted)]"
        />
      }
    >
      <Inbox className="size-4" /> Invite requests
      {pending > 0 && (
        <span
          className="ml-auto rounded-full px-2 text-xs font-medium"
          style={{ background: "var(--color-primary)", color: "var(--color-on-primary)" }}
        >
          {pending}
        </span>
      )}
    </SheetClose>
  );
}

/** Decorative: the count itself is read out on the link inside the menu. */
function PendingDot({ count }: { count: Promise<number | null> }) {
  const pending = use(count);
  if (!pending) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="pending-requests-dot"
      className="absolute top-1.5 right-1.5 size-2 rounded-full"
      style={{ background: "var(--color-primary)" }}
    />
  );
}
